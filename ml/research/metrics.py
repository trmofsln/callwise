"""Tie-aware, weight-aware evaluation metrics for rare proxy outcomes.

Weights implement the seller-cluster bootstrap: one multinomial draw per seller, applied to
all of that seller's rows, with each model's sort order computed once. Nothing here estimates
causal scheduling lift.
"""
from __future__ import annotations

import math

import numpy as np

EPS = 1e-15


class Ranked:
    """Pre-sorted scores with tie groups, for fast repeated weighted metrics."""

    def __init__(self, scores: np.ndarray, labels: np.ndarray):
        order = np.argsort(-scores, kind="mergesort")
        self.order = order
        self.s = scores[order]
        self.y = labels[order].astype(float)
        self.p = scores
        self.labels = labels.astype(float)
        boundaries = np.r_[np.flatnonzero(np.diff(self.s) != 0), len(self.s) - 1]
        self.group_end = boundaries  # last index of each tie group
        self.group_id = np.repeat(np.arange(len(boundaries)), np.diff(np.r_[-1, boundaries]))

    def _group_sums(self, values: np.ndarray) -> np.ndarray:
        return np.bincount(self.group_id, weights=values, minlength=len(self.group_end))

    def average_precision(self, w: np.ndarray | None = None) -> float | None:
        w_sorted = np.ones(len(self.s)) if w is None else w[self.order]
        pos = self._group_sums(w_sorted * self.y)
        tot = self._group_sums(w_sorted)
        total_pos = pos.sum()
        if total_pos <= 0:
            return None
        precision = np.cumsum(pos) / np.maximum(np.cumsum(tot), EPS)
        return float(np.sum(pos / total_pos * precision))

    def roc_auc(self, w: np.ndarray | None = None) -> float | None:
        w_sorted = np.ones(len(self.s)) if w is None else w[self.order]
        pos = self._group_sums(w_sorted * self.y)
        neg = self._group_sums(w_sorted * (1 - self.y))
        if pos.sum() <= 0 or neg.sum() <= 0:
            return None
        # groups are in descending score order; negatives below = total - cumulative
        neg_below = neg.sum() - np.cumsum(neg)
        return float(np.sum(pos * (neg_below + 0.5 * neg)) / (pos.sum() * neg.sum()))

    def log_loss(self, w: np.ndarray | None = None) -> float:
        w = np.ones(len(self.p)) if w is None else w
        p = np.clip(self.p, EPS, 1 - EPS)
        return float(-np.sum(w * (self.labels * np.log(p) + (1 - self.labels) * np.log(1 - p))) / w.sum())

    def brier(self, w: np.ndarray | None = None) -> float:
        w = np.ones(len(self.p)) if w is None else w
        return float(np.sum(w * (self.p - self.labels) ** 2) / w.sum())

    def at_budget(self, fraction: float, w: np.ndarray | None = None) -> dict:
        """Expected proxy events in the top fraction of calls; ties split uniformly."""
        w_sorted = np.ones(len(self.s)) if w is None else w[self.order]
        pos = self._group_sums(w_sorted * self.y)
        tot = self._group_sums(w_sorted)
        budget = fraction * tot.sum()
        cum = np.cumsum(tot)
        full = cum <= budget
        taken = pos[full].sum()
        k = int(full.sum())
        if k < len(tot):
            remaining = budget - (cum[k - 1] if k else 0.0)
            taken += pos[k] * remaining / tot[k] if tot[k] else 0.0
        total = pos.sum()
        return {"budget_fraction": fraction, "calls": budget, "proxy_events": taken,
                "yield": taken / budget if budget else None,
                "recall": taken / total if total else None,
                "calls_per_proxy_event": budget / taken if taken else None}


def summary(scores: np.ndarray, labels: np.ndarray) -> dict:
    r = Ranked(scores, labels)
    n, positives = int(len(labels)), int(labels.sum())
    out = {"n": n, "positives": positives, "prevalence": positives / n if n else None,
           "average_precision": r.average_precision(), "roc_auc": r.roc_auc(),
           "log_loss": r.log_loss() if n else None, "brier": r.brier() if n else None,
           "mean_score": float(scores.mean()) if n else None}
    out["budgets"] = {str(f): r.at_budget(f) for f in (0.1, 0.2, 0.3)} if n else {}
    if positives == 0:
        out["note"] = "zero positives: AP/ROC undefined; positive-class discrimination not assessable"
    return out


def reliability(scores: np.ndarray, labels: np.ndarray, bins: int = 10) -> list[dict]:
    if not len(scores):
        return []
    edges = np.unique(np.quantile(scores, np.linspace(0, 1, bins + 1)))
    idx = np.clip(np.searchsorted(edges, scores, side="right") - 1, 0, max(len(edges) - 2, 0))
    rows = []
    for b in range(max(len(edges) - 1, 1)):
        mask = idx == b
        if mask.any():
            rows.append({"bin": b, "n": int(mask.sum()), "mean_predicted": float(scores[mask].mean()),
                         "observed_rate": float(labels[mask].mean()), "positives": int(labels[mask].sum())})
    return rows


def within_seller_concordance(scores: np.ndarray, labels: np.ndarray, sellers: np.ndarray, hours: np.ndarray) -> dict:
    """Share of (positive, negative) call pairs of the same seller at different hours where the
    positive call scored higher (ties count 0.5). Measures *when*, holding the customer fixed."""
    order = np.argsort(sellers, kind="mergesort")
    s, y, g, h = scores[order], labels[order], sellers[order], hours[order]
    bounds = np.flatnonzero(np.r_[True, g[1:] != g[:-1], True])
    concordant = pairs = 0.0
    sellers_used = 0
    for lo, hi in zip(bounds[:-1], bounds[1:]):
        yy = y[lo:hi]
        if yy.min() == yy.max():
            continue
        ps, ph = s[lo:hi][yy == 1], h[lo:hi][yy == 1]
        ns, nh = s[lo:hi][yy == 0], h[lo:hi][yy == 0]
        diff_hour = ph[:, None] != nh[None, :]
        if not diff_hour.any():
            continue
        sellers_used += 1
        cmp = (ps[:, None] > ns[None, :]) + 0.5 * (ps[:, None] == ns[None, :])
        concordant += float(np.sum(cmp * diff_hour))
        pairs += float(np.sum(diff_hour))
    return {"sellers": sellers_used, "pairs": pairs, "concordance": concordant / pairs if pairs else None}


def cluster_weights(sellers: np.ndarray, reps: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Return (seller index per row, generator) for seller-cluster bootstrap draws."""
    _, inverse = np.unique(sellers, return_inverse=True)
    return inverse, np.random.default_rng(seed)


def paired_bootstrap(models: dict[str, np.ndarray], labels: np.ndarray, sellers: np.ndarray,
                     comparisons: list[tuple[str, str]], reps: int = 1000, seed: int = 20261010) -> dict:
    inverse, rng = cluster_weights(sellers, reps, seed)
    k = inverse.max() + 1
    ranked = {name: Ranked(s, labels) for name, s in models.items()}
    draws = {f"{a}-vs-{b}": {"ap": [], "log_loss": [], "brier": [], "yield@0.2": []} for a, b in comparisons}
    for _ in range(reps):
        counts = rng.multinomial(k, np.full(k, 1.0 / k)).astype(float)
        w = counts[inverse]
        cache = {}
        for name, r in ranked.items():
            cache[name] = (r.average_precision(w), r.log_loss(w), r.brier(w), r.at_budget(0.2, w)["yield"])
        for a, b in comparisons:
            d = draws[f"{a}-vs-{b}"]
            if cache[a][0] is not None and cache[b][0] is not None:
                d["ap"].append(cache[a][0] - cache[b][0])
                d["yield@0.2"].append(cache[a][3] - cache[b][3])
            d["log_loss"].append(cache[a][1] - cache[b][1])
            d["brier"].append(cache[a][2] - cache[b][2])
    out = {}
    for a, b in comparisons:
        key = f"{a}-vs-{b}"
        point_a, point_b = ranked[a], ranked[b]
        ap_a, ap_b = point_a.average_precision(), point_b.average_precision()
        out[key] = {
            "ap_difference": None if ap_a is None or ap_b is None else ap_a - ap_b,
            "ap_relative": None if not ap_a or not ap_b else ap_a / ap_b - 1,
            "log_loss_difference": point_a.log_loss() - point_b.log_loss(),
            "brier_difference": point_a.brier() - point_b.brier(),
            "yield@0.2_difference": point_a.at_budget(0.2)["yield"] - point_b.at_budget(0.2)["yield"],
            "intervals_95": {m: (None if len(v) < reps * 0.9 else [float(np.quantile(v, 0.025)), float(np.quantile(v, 0.975))])
                             for m, v in draws[key].items()},
            "replicates": reps, "cluster": "seller", "seed": seed,
        }
    return out


def safe(value):
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value
