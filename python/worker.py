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
  amounts    pooled regressor over the request's debits, fit and
             predict on the same rows (expected-amount scoring)

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


def amounts_job(debits):
    train = []
    test = []
    for d in debits:
        row = {f: d[f] for f in AMOUNT_FEATURES}
        train.append({**row, "target": d["amount"]})
        test.append({**row, "key": d["id"]})
    return fit_predict(train, test, AMOUNT_FEATURES)


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
