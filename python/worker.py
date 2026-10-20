#!/usr/bin/env python3
"""Ledger Sloth TabPFN sidecar (DESIGN §2).

Spawn-per-run: reads exactly one JSON request from stdin, writes
exactly one JSON object to stdout, exits. All diagnostics go to
stderr. Python does *only* ML — fit/predict, raw numbers out; every
judgment (benchmark winner, anomaly thresholds, reason strings)
lives in TypeScript.

Jobs (DESIGN §2/§3):
  forecast   pooled TabPFNRegressor on TS-built sliding samples
  benchmark  same builder, cutoff moved (samples arrive pre-built)
  amounts    pooled regressor over the request's debits, scored
             OUT-OF-FOLD (K-fold cross-fitting): each debit is
             predicted by a model fit on the other folds, never on
             a training set containing itself. Self-scoring leaks —
             TabPFN is an in-context learner and partly reproduces
             an outlier it can see (measured: the planted ₹32,999
             charge "expected" ₹20,294 when scored in-sample, even
             with de-leaked features). Cross-fitting is the standard
             de-leaked way to score rows for anomaly detection.

The v3.5 checkpoint and license token come from the local tabpfn
cache (~/.cache/tabpfn) — fully offline after the one-time setup
download; TABPFN_TOKEN in the environment also works.
"""

import glob
import json
import os
import sys
import time

FORECAST_FEATURES = ["category", "monthIndex", "monthOfYear", "lag1", "rollMean"]
AMOUNT_FEATURES = [
    "category",
    "dayOfMonth",
    "weekday",
    "merchantKey",
    "categoryMedian",
    "merchantMedian",
]


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def make_regressor():
    from tabpfn import TabPFNRegressor

    # Fixed seed: same inputs -> same predictions, run over run.
    return TabPFNRegressor(device="cpu", random_state=42)


def frame(rows, features, with_target):
    import pandas as pd

    cols = features + (["target"] if with_target else [])
    return pd.DataFrame([{c: row.get(c) for c in cols} for row in rows], columns=cols)


def fit_predict(train_rows, test_rows, features):
    """Fit on train_rows (with target), predict test_rows.
    Returns {test_row['key']: float} — empty dict on empty input."""
    if not train_rows or not test_rows:
        return {}
    model = make_regressor()
    x_train = frame(train_rows, features, with_target=True)
    y_train = x_train.pop("target")
    model.fit(x_train, y_train)
    x_test = frame(test_rows, features, with_target=False)
    preds = model.predict(x_test)
    return {str(row["key"]): round(float(p), 2) for row, p in zip(test_rows, preds)}


def samples_job(sample_set):
    train = sample_set.get("train", [])
    test = sample_set.get("test", [])
    return fit_predict(train, test, FORECAST_FEATURES)


AMOUNTS_FOLDS = 5


def amounts_job(debits):
    """Out-of-fold expected amounts via deterministic K-fold
    cross-fitting (fold = position in id order). With fewer rows
    than folds, folds shrink to the row count; a single debit cannot
    be held out from anything, so it falls back to a self-fit (its
    prediction then tracks itself and TS's flag rule stays quiet —
    honest, since one row is no history to be anomalous against)."""
    rows = sorted(debits, key=lambda d: d["id"])
    n = len(rows)
    if n == 0:
        return {}
    if n == 1:
        d = rows[0]
        row = {f: d[f] for f in AMOUNT_FEATURES}
        return fit_predict([{**row, "target": d["amount"]}], [{**row, "key": d["id"]}], AMOUNT_FEATURES)
    folds = min(AMOUNTS_FOLDS, n)
    out = {}
    for fold in range(folds):
        train = []
        test = []
        for i, d in enumerate(rows):
            row = {f: d[f] for f in AMOUNT_FEATURES}
            if i % folds == fold:
                test.append({**row, "key": d["id"]})
            else:
                train.append({**row, "target": d["amount"]})
        out.update(fit_predict(train, test, AMOUNT_FEATURES))
    return out


def checkpoint_name():
    cache = os.path.expanduser("~/.cache/tabpfn")
    hits = sorted(glob.glob(os.path.join(cache, "tabpfn-v3.5-*.safetensors")))
    return os.path.basename(hits[0]) if hits else "unknown"


def tabpfn_version():
    try:
        import importlib.metadata

        return importlib.metadata.version("tabpfn")
    except Exception:
        import tabpfn

        return getattr(tabpfn, "__version__", "unknown")


def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"invalid JSON request: {exc}"}))
        return 1

    jobs = req.get("jobs", [])
    samples = req.get("samples", {})
    result = {"ok": True}
    fit_seconds = {}

    try:
        for job in jobs:
            t0 = time.perf_counter()
            if job in ("forecast", "benchmark"):
                result[job] = samples_job(samples.get(job) or {})
            elif job == "amounts":
                result[job] = amounts_job(req.get("debits", []))
            else:
                raise ValueError(f"unknown job: {job}")
            fit_seconds[job] = round(time.perf_counter() - t0, 2)
    except Exception as exc:  # one-line reason out; traceback to stderr
        import traceback

        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1

    result["meta"] = {
        "tabpfn": tabpfn_version(),
        "checkpoint": checkpoint_name(),
        "fitSeconds": fit_seconds,
    }
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
