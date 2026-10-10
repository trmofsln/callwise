"""Exploratory (post-lock) timing analysis: seller-cluster bootstrap intervals for differences in
within-seller hour concordance between frozen models. Uses the already-frozen bundles and the
sealed test only after ``test-lock.json`` exists; no model is refitted or tuned. Output is
labelled exploratory: ``models/<population>/timing-exploratory.json``.

Usage: ``python -m ml.research.analyze_timing [all|channel]``
"""
from __future__ import annotations

import json
import pickle
import sys

import numpy as np
import pandas as pd

from ml.research import metrics
from ml.research.dataset import OUT as DATA
from ml.research.train import PRIMARY, output_dir, population_frame


def pairs_by_seller(scores: dict[str, np.ndarray], y, sellers, hours):
    """Per seller: (concordant sum, pair count) for each model over positive/negative pairs at different hours."""
    order = np.argsort(sellers, kind="mergesort")
    g = sellers[order]
    bounds = np.flatnonzero(np.r_[True, g[1:] != g[:-1], True])
    rows = []
    for lo, hi in zip(bounds[:-1], bounds[1:]):
        idx = order[lo:hi]
        yy = y[idx]
        if yy.min() == yy.max():
            continue
        pos, neg = idx[yy == 1], idx[yy == 0]
        diff = hours[pos][:, None] != hours[neg][None, :]
        if not diff.any():
            continue
        row = {"pairs": float(diff.sum())}
        for name, s in scores.items():
            c = (s[pos][:, None] > s[neg][None, :]) + 0.5 * (s[pos][:, None] == s[neg][None, :])
            row[name] = float(np.sum(c * diff))
        rows.append(row)
    return pd.DataFrame(rows)


def main() -> None:
    population = sys.argv[1] if len(sys.argv) > 1 else "all"
    out = output_dir(population)
    if not (out / "test-lock.json").exists():
        raise SystemExit("Run the one-shot evaluation first; this analysis is post-lock and exploratory.")
    bundle = pickle.loads((out / "frozen-candidates.pkl").read_bytes())
    test = population_frame(pd.read_parquet(DATA / "test-sealed.parquet"), population).reset_index(drop=True)
    y = test[PRIMARY].to_numpy()
    scores = {"F0_frozen_general_erp": bundle["frozen_general"]["pooled"].predict(test)}
    for name, model in bundle["models"].items():
        scores[name] = model.predict(test)  # calibration is monotone; concordance unaffected
    table = pairs_by_seller(scores, y, test["seller_key"].to_numpy(), test["hour"].to_numpy())
    rng = np.random.default_rng(20261010)
    names = [n for n in scores]
    point = {n: table[n].sum() / table["pairs"].sum() for n in names}
    ref = ["F0_frozen_general_erp", bundle["b1"]]
    draws = {f"{a}-vs-{r}": [] for a in names for r in ref if a != r}
    for _ in range(1000):
        w = rng.multinomial(len(table), np.full(len(table), 1 / len(table)))
        tot = np.sum(w * table["pairs"].to_numpy())
        c = {n: np.sum(w * table[n].to_numpy()) / tot for n in names}
        for key in draws:
            a, r = key.split("-vs-")
            draws[key].append(c[a] - c[r])
    result = {"exploratory": True, "population": population, "sellers_with_pairs": int(len(table)),
              "pairs": float(table["pairs"].sum()), "concordance": point,
              "differences": {k: {"point": point[k.split("-vs-")[0]] - point[k.split("-vs-")[1]],
                                  "ci95": [float(np.quantile(v, 0.025)), float(np.quantile(v, 0.975))]}
                              for k, v in draws.items()},
              "interpretation": "within-seller ranking of call hours; associational; post-lock exploratory"}
    (out / "timing-exploratory.json").write_text(json.dumps(result, indent=1, default=metrics.safe))
    for k, v in result["differences"].items():
        print(f"{k:75s} {v['point']:+.4f} [{v['ci95'][0]:+.4f}, {v['ci95'][1]:+.4f}]")


if __name__ == "__main__":
    main()
