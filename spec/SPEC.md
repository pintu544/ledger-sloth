# SPEC — Ledger Sloth (DEV × MLH Hacktoberfest Week 3, "Slow and Steady")

> Status: DRAFT for Pintu's approval (spec-driven Phase 1). Concept #3 from
> `../GRILL-DRAFT.md`. Deadline Oct 25, 23:59 UTC; submit Oct 24.
> Demo that proves it works: `npx tsx src/index.ts report fixtures/statement.csv`
> produces a month-in-review report + categorized CSV whose category accuracy
> and forecast-vs-baseline numbers can be checked against the fixture's
> ground truth by hand.

## Problem

Everyone postpones the same monthly chore: opening the bank/UPI statement,
working out where the money went, noticing the subscription that renewed
silently and the charge that looks wrong, and guessing what next month will
cost. Ledger Sloth does that chore locally and slowly, overnight if you like:
it reads a statement CSV, categorizes every transaction, writes a
plain-English month-in-review, forecasts next month's per-category spend with
TabPFN, and flags charges that look anomalous — without the statement ever
leaving the user's machine.

## Users

- **Individuals** reconciling a personal Indian bank/UPI statement each month.
- **Freelancers / indie hackers** who want an accountant-ready categorized CSV
  without uploading financial data to a SaaS.

## Functional requirements

1. The system SHALL accept one bank/UPI statement CSV per run and map its
   columns flexibly: a date column, a description/narration column, and
   amounts as either separate debit/credit columns or one signed amount
   column; a balance column SHALL be optional.
2. The system SHALL normalize every parsed row into
   `{date, description, amount (signed, INR), balance?}` and SHALL exclude
   non-transaction rows (headers, totals, opening/closing balance lines) from
   all downstream stages.
3. The system SHALL categorize each transaction in this order: (a) the local
   user-correction memory, (b) deterministic merchant rules, (c) Gemma 3 4B
   via Ollama for everything still uncategorized. Every row SHALL end with
   exactly one category from a fixed category list.
4. The system SHALL persist user corrections of categories to a local memory
   file so the same merchant/description pattern is categorized the user's way
   on later runs, with no retraining step.
5. The system SHALL compute per-category totals and counts for the statement
   month and month-over-month deltas when earlier months are present.
6. The system SHALL generate a plain-English month-in-review narrative using
   Gemma 3 4B via Ollama, grounded only in the computed aggregates (totals,
   deltas, top merchants, flagged anomalies) — the narrative SHALL NOT
   introduce figures that are not in the aggregates.
7. The system SHALL forecast next month's spend per category using TabPFN
   (`TabPFNRegressor`, local `tabpfn` package, TabPFN-3.5 checkpoint) trained
   on the monthly per-category history present in the input.
8. The system SHALL flag anomalous charges using TabPFN: each debit SHALL be
   scored against a TabPFN model of expected amounts given transaction
   features (e.g. category, day of month, amount history for that
   merchant/category), and outliers SHALL be listed with amount, date,
   description, and a one-line reason.
9. The system SHALL benchmark every forecast against a naive baseline
   ("next month = latest month, per category") on any month that can be
   held out, and SHALL print both errors and which one won in the report —
   win or lose, with no rounding or framing that hides a loss.
10. The system SHALL emit two artifacts per run: a human-readable report
    (`.md`, plus a self-contained `.html` rendering) and a categorized CSV
    containing every input transaction with its assigned category.
11. The system SHALL print a run-metrics block (rows parsed, per-stage
    seconds, model names/versions) at the end of every report.

## Non-functional requirements

- **Privacy / network:** after one-time model setup (Ollama pull; TabPFN
  checkpoint download with `TABPFN_TOKEN`), a full run SHALL make zero
  outbound network calls. Statement data SHALL never be transmitted anywhere.
- **Hardware:** a full run on the synthetic fixture (hundreds of rows) SHALL
  complete on a 2 vCPU / 7.7 GB RAM / no-GPU machine, with Gemma and TabPFN
  loaded **sequentially**, never resident at the same time.
- **Reproducibility:** the same input + same correction memory SHALL produce
  byte-identical categorized CSV output across runs.
- **Install footprint (day-1 spike must confirm):** the Python sidecar uses
  CPU-only PyTorch (installed before `tabpfn` to avoid the multi-GB CUDA
  build); total added disk for Python env + TabPFN-3.5 checkpoint SHALL be
  reported in the DEV post honestly, whatever it measures.

## Failure modes (all mandatory, none optional)

- **Empty or garbage CSV** → fail with a plain message naming the problem;
  no artifacts produced.
- **Unrecognized columns** (no plausible date/description/amount mapping) →
  fail listing the headers found and the shapes Ledger Sloth can read; never
  guess silently.
- **Ollama not running / model not pulled** → fail with the exact fix commands
  (`ollama serve`, `ollama pull gemma3:4b`), not a stack trace.
- **TabPFN unavailable** (package missing, token unset, weights not
  downloaded) → produce the report with the forecast and anomaly sections
  replaced by an explicit "unavailable because …" note. The sections SHALL
  NEVER be silently dropped or filled with fabricated numbers.
- **Single-month data** → the forecast section SHALL state that at least two
  months of history are needed and skip forecasting; anomaly flagging may
  still run within the month. The system SHALL NOT fabricate a forecast from
  one month.
- **A category with zero history** in the forecast month SHALL be reported as
  "no history — no forecast," not predicted as ₹0 without a note.

## Acceptance criteria

- A synthetic Indian bank/UPI fixture (multiple months; salary credit, rent,
  UPI P2P, Swiggy/Zomato, subscriptions, one planted anomalous charge) with
  ground-truth categories ships in `fixtures/`; categorization accuracy
  against ground truth is computed by a test and printed (target ≥ 85% on the
  fixture; the measured number, whatever it is, goes in the post).
- The planted anomalous charge appears in the report's anomaly list.
- Forecast benchmark (FR-9) runs on the fixture's held-out month and its
  result — TabPFN vs naive baseline — is printed verbatim in the report.
- A test with networking disabled (post-setup) completes a full run.
- Each failure mode above has a test demonstrating the specified behavior.

## Judging criteria → requirements map

- **Writing Quality (weighted most):** the honest benchmark (FR-9), the
  run-metrics block (FR-11), and the privacy story below give the post its
  substance; post skeleton is drafted on day 2, not day 4.
- **Theme relevance ("Slow and Steady"):** a dreaded monthly chore done
  slowly, locally, in batch — the slowness is the design, not an apology.
- **Creativity:** two open models doing two different jobs (language vs
  tabular) composed in one agent.
- **Technical Execution:** acceptance criteria above, all fixture-verifiable.
- **Partner — Best Use of TabPFN ($200 featured):** FR-7 + FR-8 put
  TabPFN-3.5 (the version Prior Labs recommends for this category) inside a
  wider prediction agent — the shape the category text says it favors.
- **Partner — Best Use of Gemma ($200 featured):** FR-3(c) + FR-6 make Gemma
  load-bearing for categorization and the narrative.
- **Why open innovation matters (required by the prompt):** a bank statement
  is data you never upload to a stranger's API. Open-weight models make this
  product *possible*, not just cheaper: fully offline after setup, ₹0 per
  run forever, and the user can teach it their own merchants locally (FR-4).

## Claims discipline (applies to code, report, and the DEV post)

- Gemma is **open-weight under the Gemma Terms of Use** — always say
  "open-weight," never "open-source," for Gemma.
- TabPFN-3.5 weights are **open-weight, free for non-commercial use under the
  TABPFN-3-5 License v1.0**, unlocked by a one-time license acceptance at
  platform.priorlabs.ai; the `tabpfn` package code is Apache 2.0. Never call
  TabPFN weights "open-source" or "Apache-licensed."
- Forecast claims are limited to the measured fixture benchmark (FR-9). If
  TabPFN ties or loses to the naive baseline, the post says so and rests the
  value on categorization + anomaly flags.

## Out of scope

- Real bank connections, banking APIs, screen-scraping, or account login.
- PDF statements — CSV only in v1.
- Sending or sharing the report anywhere (no email/WhatsApp/cloud upload);
  the tool only writes local files.
- Merging multiple accounts or multiple statement files in one run.
- The hosted TabPFN API / `tabpfn-client` / Thinking Mode — local inference
  only (keeps the offline claim airtight).
- Budgets, alerts, or any daemon/scheduled mode.

## Open decisions flagged for DESIGN

- **Sidecar protocol:** TS orchestrator ↔ Python TabPFN worker (spawn per run
  vs long-lived process) — DESIGN decides; SPEC only requires sequential
  model residency (NFR above).
- **Forecast training shape:** one regressor per category vs one regressor
  with category as a categorical feature — DESIGN decides against the fixture;
  FR-9's honest benchmark is the arbiter.

## Research (verified Oct 20, 2026)

- **DEV challenge page** — Best Use of TabPFN ($200 featured): "Prior Labs
  strongly recommends the latest version, TabPFN-3.5: it's open-weight and
  free to use once you sign the non-commercial license at
  platform.priorlabs.ai, and you can then run it locally… Prior Labs favors
  projects that use TabPFN inside a wider prediction agent (with or without
  the MCP server)." Writing Quality weighted most heavily.
  https://dev.to/challenges/hacktoberfest-week3-2026-10-19
- **PyPI `tabpfn` 9.2.0** (current): wheel 0.85 MB; `requires_python >=3.10`
  (3.10–3.14; this VM runs Python 3.12.3 ✓); depends on `torch>=2.5` —
  PyTorch dominates install size; README advises installing CPU-only PyTorch
  first on GPU-less machines to save disk. Default model is **TabPFN-3.5**;
  one checkpoint file (`tabpfn-v3.5-20260909.safetensors`) serves both
  `TabPFNClassifier` and `TabPFNRegressor` (scikit-learn-style fit/predict).
  https://pypi.org/pypi/tabpfn/json · https://pypi.org/project/tabpfn/
- **License flow (PyPI README FAQ):** first use opens a browser to log in and
  accept the license; token cached locally. Headless/CI: accept the license
  on the platform's License tab, copy the token from the account page, set
  env var **`TABPFN_TOKEN`**. Accepting the license shares no datasets with
  Prior Labs; the package works fully offline once weights are downloaded.
  Manual-download fallback via Hugging Face (`Prior-Labs/tabpfn_3_5`) +
  `TABPFN_MODEL_CACHE_DIR`. Full click-path: `../TABPFN-SIGNUP-STEPS.md`.
- **Licensing:** package code Apache 2.0; TabPFN-3.5 (and 2.5/2.6/3) weights
  under per-version **non-commercial** licenses (TABPFN-3-5 License v1.0);
  TabPFNv2 weights under the Prior Labs License (Apache 2.0 + attribution).
  https://docs.priorlabs.ai/models
- **Dataset limits:** TabPFN-3.5 model ceiling 1,000,000 rows / 20,000
  columns, but the package's **CPU guardrail is 5,000 samples** for
  TabPFN-3/3.5/3.5-Fast (1,000 for older versions; override
  `TABPFN_ALLOW_CPU_LARGE_DATASET=true`). Ledger Sloth's TabPFN inputs —
  monthly per-category aggregates (tens of rows) and per-transaction scoring
  (hundreds–low thousands) — sit far inside the CPU limit.
  https://docs.priorlabs.ai/models · PyPI README (env-var FAQ)
- **CPU feasibility:** Prior Labs recommends a GPU, but CPU inference is
  supported and bounded by the 5,000-sample guardrail; at fixture scale
  (≤ a few thousand rows, batched predict) a 2 vCPU run is a batch job
  measured in minutes at worst — acceptable for an overnight-batch product,
  and the day-1 spike must measure it rather than assume it.
