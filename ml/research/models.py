"""Candidate model families for research v4 (see docs/best-time-to-call/research-v4/experiment-plan.md).

Every model exposes ``fit(frame, target)`` and ``predict(frame) -> np.ndarray`` of probabilities,
uses only pre-call features, and behaves safely for unseen sellers and unseen clock cells.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import sparse
from sklearn.linear_model import LogisticRegression

from ml.research.dataset import FEATURES_CONTEXT, FEATURES_HISTORY

CAT_CONTEXT = ["module_group", "custtype_id", "vertical_id", "is_sts_assigned", "flag_call_type", "vendor"]


def logit(p: np.ndarray, clip: float = 1e-6) -> np.ndarray:
    p = np.clip(p, clip, 1 - clip)
    return np.log(p / (1 - p))


def sigmoid(z: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-np.clip(z, -40, 40)))


# --------------------------------------------------------------------------- baselines
class Constant:
    name = "B0_population_rate"

    def fit(self, df, y):
        self.rate = (y.sum() + 1) / (len(y) + 2)
        return self

    def predict(self, df):
        return np.full(len(df), self.rate)


class HourDay:
    """Same family as the frozen general model: smoothed weekday:hour rates with the app's
    pooled-hour backoff when a cell has fewer than 5 training rows."""

    def __init__(self, strength: float = 20.0, min_support: int = 5):
        self.strength, self.min_support = strength, min_support
        self.name = f"B1_hour_day_s{strength:g}"

    def fit(self, df, y):
        self.global_ = {"count": int(len(y)), "positive": int(y.sum())}
        self.rate = (y.sum() + 1) / (len(y) + 2)
        g = pd.DataFrame({"k": df["weekday"].astype(str) + ":" + df["hour"].astype(str), "h": df["hour"], "y": y})
        self.bins = {k: (int(v.size), int(v.sum())) for k, v in g.groupby("k")["y"]}
        self.hours = {int(h): (int(v.size), int(v.sum())) for h, v in g.groupby("h")["y"]}
        return self

    def _score(self, weekday: int, hour: int) -> float:
        count, positive = self.bins.get(f"{weekday}:{hour}", (0, 0))
        if count < self.min_support:
            count, positive = self.hours.get(hour, (0, 0))
        if count < self.min_support:
            return float(self.rate)
        return (positive + self.strength * self.rate) / (count + self.strength)

    def predict(self, df):
        cache: dict[tuple[int, int], float] = {}
        keys = list(zip(df["weekday"].astype(int), df["hour"].astype(int)))
        return np.array([cache.setdefault(k, self._score(*k)) for k in keys])

    def artifact_smoothing(self) -> dict:
        return {"strength": self.strength, "global": self.global_,
                "bins": {k: {"count": c, "positive": p} for k, (c, p) in sorted(self.bins.items())}}


class FrozenGeneral:
    """Frozen .data/btc-operational-v3/models/general_erp model scored exactly like
    lib/best-time-experiments.ts scoreExperimentalClock (poolHours=true). Unsupported cells,
    which the app would drop, get the calibrated global prior and are counted."""

    name = "F0_frozen_general_erp"

    def __init__(self, path: Path, pool_hours: bool = True):
        self.model = json.loads(path.read_text())
        self.pool_hours = pool_hours
        if not pool_hours:
            self.name = "F0_frozen_general_erp_global_prior_backoff"
        sm = self.model["smoothing"]
        self.rate = (sm["global"]["positive"] + 1) / (sm["global"]["count"] + 2)
        self.unsupported = 0

    def fit(self, df, y):
        return self

    def _calibrate(self, score: float) -> float:
        cal = self.model["calibration"]
        clip = cal.get("clip") or 1e-8
        score = min(1 - clip, max(clip, score))
        return 1 / (1 + math.exp(-(cal["slope"] * math.log(score / (1 - score)) + cal["intercept"])))

    def _score(self, weekday: int, hour: int) -> tuple[float, bool]:
        sm = self.model["smoothing"]
        b = sm["bins"].get(f"{weekday}:{hour}")
        count, positive = (b["count"], b["positive"]) if b else (0, 0)
        if count < 5 and self.pool_hours:
            pooled = [v for k, v in sm["bins"].items() if k.endswith(f":{hour}")]
            count, positive = sum(v["count"] for v in pooled), sum(v["positive"] for v in pooled)
        supported = count >= 5
        raw = (positive + sm["strength"] * self.rate) / (count + sm["strength"]) if supported else self.rate
        return self._calibrate(raw), supported

    def predict(self, df):
        cache = {}
        out, unsupported = [], 0
        for k in zip(df["weekday"].astype(int), df["hour"].astype(int)):
            if k not in cache:
                cache[k] = self._score(*k)
            score, supported = cache[k]
            out.append(score)
            unsupported += not supported
        self.unsupported = unsupported
        return np.array(out)


class PersonalAnswer:
    """Transparent personal baseline: clock meeting rate (B1) scaled by the seller's smoothed
    answer rate at this hour over the last 7 days relative to the population answer rate."""

    def __init__(self, prior: float = 5.0, clock_strength: float = 20.0):
        self.prior = prior
        self.clock = HourDay(clock_strength)
        self.name = f"B2_personal_answer_k{prior:g}"

    def fit(self, df, y):
        self.clock.fit(df, y)
        answered = (df["status"] == "answered").to_numpy()
        self.hour_answer = pd.Series(answered).groupby(df["hour"].to_numpy()).mean().to_dict()
        self.answer_rate = float(answered.mean())
        return self

    def predict(self, df):
        base = self.clock.predict(df)
        pop = df["hour"].map(self.hour_answer).fillna(self.answer_rate).to_numpy()
        personal = (df["answered_same_hour_7d"].to_numpy() + self.prior * pop) / (df["calls_same_hour_7d"].to_numpy() + self.prior)
        return np.clip(base * personal / np.maximum(pop, 1e-6), 1e-6, 1 - 1e-6)


# --------------------------------------------------------------------------- partial pooling
class NestedPooling:
    """Empirical-Bayes partial pooling over nested clock/context cells:
    global -> hour -> weekday:hour -> module_group:weekday:hour, each level shrunk toward its
    parent with a beta-binomial pseudo-count. Unseen cells inherit the parent estimate."""

    def __init__(self, strengths=(20.0, 20.0, 50.0)):
        self.strengths = strengths
        self.name = "H1_nested_pooling_" + "_".join(f"{s:g}" for s in strengths)
        self.levels = [["hour"], ["weekday", "hour"], ["module_group", "weekday", "hour"]]

    def _key(self, df, cols):
        return df[cols].astype(str).agg("|".join, axis=1) if len(cols) > 1 else df[cols[0]].astype(str)

    def fit(self, df, y):
        self.rate = (y.sum() + 1) / (len(y) + 2)
        self.tables = []
        for cols in self.levels:
            g = pd.DataFrame({"k": self._key(df, cols), "y": y}).groupby("k")["y"].agg(["size", "sum"])
            self.tables.append(g)
        return self

    def predict(self, df):
        est = np.full(len(df), self.rate)
        for cols, table, strength in zip(self.levels, self.tables, self.strengths):
            k = self._key(df, cols)
            n = k.map(table["size"]).fillna(0).to_numpy()
            s = k.map(table["sum"]).fillna(0).to_numpy()
            est = (s + strength * est) / (n + strength)
        return est


# --------------------------------------------------------------------------- design matrices
def history_matrix(df: pd.DataFrame) -> pd.DataFrame:
    h = pd.DataFrame(index=df.index)
    for c in ("calls_24h", "calls_7d", "answered_7d", "answered_same_hour_7d", "calls_same_hour_7d",
              "calls_today", "phys_meetings_30d", "any_meetings_30d"):
        h[c] = np.log1p(df[c].astype(float))
    h["answered_rate_7d"] = df["answered_rate_7d"].astype(float)
    h["has_call_7d"] = df["has_call_7d"].astype(float)
    h["has_meeting_30d"] = df["has_meeting_30d"].astype(float)
    hs = df["hours_since_last_call"].astype(float)
    h["hours_since_last_call_log"] = np.log1p(hs.fillna(0).clip(0, 24 * 60))
    h["hours_since_missing"] = hs.isna().astype(float)
    ds = df["days_since_meeting"].astype(float)
    h["days_since_meeting_log"] = np.log1p(ds.fillna(0).clip(0, 60))
    h["days_since_meeting_missing"] = ds.isna().astype(float)
    la = df["last_call_answered"].astype(float)
    h["last_call_answered"] = la.fillna(0)
    h["last_call_answered_missing"] = la.isna().astype(float)
    return h


@dataclass
class OneHot:
    columns: list[str]
    min_count: int = 50
    vocab: dict[str, list[str]] = field(default_factory=dict)

    def fit(self, df):
        for c in self.columns:
            counts = df[c].astype(str).value_counts()
            self.vocab[c] = sorted(counts[counts >= self.min_count].index.tolist())
        return self

    def transform(self, df) -> sparse.csr_matrix:
        blocks = []
        for c in self.columns:
            values = df[c].astype(str).to_numpy()
            index = {v: i for i, v in enumerate(self.vocab[c])}
            cols = np.array([index.get(v, -1) for v in values])
            rows = np.flatnonzero(cols >= 0)
            blocks.append(sparse.csr_matrix((np.ones(len(rows)), (rows, cols[rows])), shape=(len(df), len(self.vocab[c]))))
        return sparse.hstack(blocks).tocsr()

    def names(self):
        return [f"{c}={v}" for c in self.columns for v in self.vocab[c]]


FEATURE_SETS = {
    "clock": {"cat": ["hour", "weekday", "weekday_hour"], "history": False},
    "clock_context": {"cat": ["hour", "weekday", "weekday_hour", *CAT_CONTEXT], "history": False},
    "clock_history": {"cat": ["hour", "weekday", "weekday_hour"], "history": True},
    "full": {"cat": ["hour", "weekday", "weekday_hour", *CAT_CONTEXT], "history": True},
}


def with_derived(df: pd.DataFrame) -> pd.DataFrame:
    if "weekday_hour" not in df:
        df = df.assign(weekday_hour=df["weekday"].astype(str) + ":" + df["hour"].astype(str))
    return df


class Logistic:
    """L2-regularized logistic regression on one-hot clock/context and scaled history features."""

    def __init__(self, feature_set: str = "full", C: float = 0.1):
        self.feature_set, self.C = feature_set, C
        self.name = f"L1_logistic_{feature_set}_C{C:g}"

    def _design(self, df, fit=False):
        df = with_derived(df)
        spec = FEATURE_SETS[self.feature_set]
        if fit:
            self.encoder = OneHot(spec["cat"]).fit(df)
        parts = [self.encoder.transform(df)]
        if spec["history"]:
            h = history_matrix(df)
            if fit:
                self.mu, self.sd = h.mean(), h.std().replace(0, 1)
            parts.append(sparse.csr_matrix(((h - self.mu) / self.sd).to_numpy()))
        return sparse.hstack(parts).tocsr()

    def fit(self, df, y):
        X = self._design(df, fit=True)
        self.model = LogisticRegression(C=self.C, max_iter=2000, solver="lbfgs")
        self.model.fit(X, y)
        return self

    def predict(self, df):
        return self.model.predict_proba(self._design(df))[:, 1]


class SellerEffects(Logistic):
    """Logistic 'full' features plus a ridge-penalized training-only seller intercept (a MAP
    approximation to a Gaussian random intercept). Unseen sellers receive exactly zero effect."""

    def __init__(self, C: float = 0.1, seller_scale: float = 0.3):
        super().__init__("full", C)
        self.seller_scale = seller_scale
        self.name = f"H2_seller_random_intercept_C{C:g}_scale{seller_scale:g}"

    def _seller(self, df, fit=False):
        if fit:
            self.sellers = {s: i for i, s in enumerate(pd.unique(df["seller_key"]))}
        idx = df["seller_key"].map(self.sellers).fillna(-1).astype(int).to_numpy()
        rows = np.flatnonzero(idx >= 0)
        return sparse.csr_matrix((np.full(len(rows), self.seller_scale), (rows, idx[rows])), shape=(len(df), len(self.sellers)))

    def fit(self, df, y):
        X = sparse.hstack([self._design(df, fit=True), self._seller(df, fit=True)]).tocsr()
        self.model = LogisticRegression(C=self.C, max_iter=3000, solver="lbfgs")
        self.model.fit(X, y)
        return self

    def predict(self, df):
        X = sparse.hstack([self._design(df), self._seller(df)]).tocsr()
        return self.model.predict_proba(X)[:, 1]


class Boosted:
    """LightGBM on clock/context categories and history features."""

    def __init__(self, feature_set: str = "full", params: dict | None = None, label: str = ""):
        self.feature_set = feature_set
        self.params = {"objective": "binary", "learning_rate": 0.03, "num_leaves": 15, "min_child_samples": 200,
                       "reg_lambda": 5.0, "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 1,
                       "verbose": -1, "seed": 1729, "deterministic": True, "num_threads": 4, **(params or {})}
        self.name = f"G1_lightgbm_{feature_set}{label}"

    def _frame(self, df):
        spec = FEATURE_SETS[self.feature_set]
        cats = [c for c in spec["cat"] if c != "weekday_hour"]
        X = pd.DataFrame(index=df.index)
        for c in cats:
            if c in ("hour", "weekday"):
                X[c] = df[c].astype(int)
            else:
                X[c] = pd.Categorical(df[c].astype(str), categories=self.categories[c])
        if spec["history"]:
            X = pd.concat([X, history_matrix(df)], axis=1)
        return X

    def fit(self, df, y, valid: tuple | None = None):
        import lightgbm as lgb
        spec = FEATURE_SETS[self.feature_set]
        self.categories = {c: sorted(df[c].astype(str).value_counts().loc[lambda s: s >= 50].index) for c in spec["cat"]
                           if c not in ("hour", "weekday", "weekday_hour")}
        X = self._frame(df)
        train = lgb.Dataset(X, y, free_raw_data=False)
        rounds = self.params.pop("num_boost_round", 2000)
        callbacks, sets = [], [train]
        if valid is not None:
            sets.append(lgb.Dataset(self._frame(valid[0]), valid[1], reference=train))
            callbacks.append(lgb.early_stopping(100, verbose=False))
        self.booster = lgb.train(self.params, train, num_boost_round=rounds, valid_sets=sets, callbacks=callbacks)
        self.best_iteration = self.booster.best_iteration or rounds
        return self

    def predict(self, df):
        return self.booster.predict(self._frame(df), num_iteration=self.best_iteration)


class TwoStage:
    """P(answered) x P(meeting | answered), each LightGBM on the same pre-call features.
    The product is not assumed calibrated; it is Platt-recalibrated on dev before comparison."""

    def __init__(self, feature_set: str = "full"):
        self.answer = Boosted(feature_set, label="_answer")
        self.convert = Boosted(feature_set, {"min_child_samples": 100}, label="_convert")
        self.name = f"T1_two_stage_{feature_set}"

    def fit(self, df, y, valid: tuple | None = None):
        answered = (df["status"] == "answered").to_numpy().astype(int)
        v_answer = v_convert = None
        if valid is not None:
            va = (valid[0]["status"] == "answered").to_numpy()
            v_answer = (valid[0], va.astype(int))
            v_convert = (valid[0][va], valid[1][va])
        self.answer.fit(df, answered, v_answer)
        mask = answered == 1
        self.convert.fit(df[mask], y[mask], v_convert)
        return self

    def predict(self, df):
        return self.answer.predict(df) * self.convert.predict(df)


# --------------------------------------------------------------------------- calibration
class Platt:
    """Platt scaling on logit(score) with a non-negative slope (same form as the frozen model)."""

    def fit(self, scores, y):
        z = logit(scores).reshape(-1, 1)
        lr = LogisticRegression(C=1e6, max_iter=1000).fit(z, y)
        self.slope, self.intercept = float(max(lr.coef_[0, 0], 0.0)), float(lr.intercept_[0])
        if self.slope == 0.0:
            self.intercept = float(logit(np.array([y.mean()]))[0])
        return self

    def __call__(self, scores):
        return sigmoid(self.slope * logit(scores) + self.intercept)
