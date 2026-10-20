# DESIGN — Ledger Sloth (DEV × MLH Hacktoberfest Week 3, "Slow and Steady")

> **Status: DRAFT for Pintu's approval — spec-driven Phase 2.** Requirements:
> `SPEC.md` (11 SHALLs, failure modes, acceptance criteria). Concept #3 from
> `../GRILL-DRAFT.md`. This document resolves the two decisions SPEC left
> open (§2, §3) and fixes the architecture everything else follows.
>
> **Locked inputs (Pintu, Oct 20, "according to you"):**
> - **Fixture format = HDFC Bank CSV layout** (primary reference shape; the
>   parser's flexible mapping must also cover ICICI/SBI-style variants).
> - **Host = this VM, first** (2 vCPU / 7.7 GB RAM, sequential model
>   residency). Pintu's Windows machine is a fallback only if the day-1
>   benchmark fails — nothing in this design depends on unknown Windows
>   specs.

---

## 1. Architecture

One CLI, one direction of flow, two models that are never in memory at the
same time. There is no server, no database, and no network call after setup
anywhere in this diagram — that is the product's privacy claim, enforced by
structure rather than by policy.

```
statement.csv
   │
   ▼
[1] PARSE ────────────── csv.ts → columns.ts (HDFC primary, ICICI/SBI
   │                      variants) → normalize.ts
   │                      Txn[] {id, date, description, amount, balance?}
   ▼
[2] CATEGORIZE (rules) ── memory.ts → rules.ts — no model resident
   │                      every row tagged with its source: memory|rule|—
   ▼
[3] CATEGORIZE (Gemma) ── gemma.ts → Ollama @ localhost:11434
   │                      leftover rows only, batched, temp 0;
   │                      final request sends keep_alive: 0 → Gemma unloads
   ▼
[4] AGGREGATE ────────── aggregate.ts — totals, counts, MoM deltas,
   │                      top merchants, per-category median/MAD
   ▼
[5] TABPFN ───────────── tabpfn/client.ts spawns python/worker.py ONCE
   │                      (Gemma is unloaded; PyTorch is the only model
   │                      resident). One process returns raw predictions
   │                      for three jobs: forecast, benchmark, amounts.
   │                      Process exits → memory fully released.
   ▼
[6] NARRATIVE ────────── gemma.ts again (Gemma reloads, keep_alive: 0)
   │                      one prompt containing ONLY the aggregates JSON;
   │                      deterministic figure-grounding check afterwards
   ▼
[7] RENDER ───────────── report/render.ts + html.ts + csvOut.ts
                          → out/report.md, out/report.html,
                            out/categorized.csv, run-metrics block (FR-11)
```

**Why this order.** The narrative (FR-6) must be grounded in aggregates
*and* the flagged anomalies, so it runs after TabPFN — which forces two
Gemma residencies (categorize, then narrate) with TabPFN sandwiched
between them. Gemma 4B reload on CPU costs seconds; TabPFN inference
costs minutes. Paying two loads is the cheap price for never holding both.

**RAM arithmetic (the NFR made concrete).** Gemma 3 4B (Q4) ≈ 3.3 GB
weights, Ollama peak RSS ≈ 4–4.5 GB. TabPFN sidecar: CPU PyTorch + TabPFN-
3.5 checkpoint ≈ 2 GB peak (day-1 spike measures the real number). Node
orchestrator ≈ 200 MB. Sequential peaks fit in 7.7 GB with headroom;
simultaneous residency (≈ 6.5–7 GB + OS) is exactly the OOM the SPEC
forbids — so the design makes it impossible rather than unlikely (§2).

---

## 2. Decision A — Sidecar protocol: **spawn-per-run, one JSON document over stdio**

**Decided:** the TS orchestrator spawns `python3 python/worker.py` **once
per Ledger Sloth run**, writes one JSON request to its stdin, reads one
JSON response from its stdout, and the process exits. All three TabPFN
jobs (forecast, benchmark, amount predictions) ride in that single
invocation, so torch import + checkpoint load are paid once. Python logs
go to stderr only; stdout carries exactly one JSON object.

**Why not a long-lived worker:**

1. **Sequential residency becomes structural, not disciplined.** A
   long-lived Python process holds torch + checkpoint in RSS indefinitely.
   Keeping it out of Gemma's way would need explicit unload messages and
   perfect bookkeeping — one forgotten unload on a 7.7 GB box is an OOM
   mid-run. A process that doesn't exist cannot be resident.
2. **The tool is a batch CLI.** There is no server anywhere else in the
   design; a worker daemon would add socket/port lifecycle, zombie
   reaping, and stale-state bugs to serve a caller that runs once and
   exits. Spawn-per-run has one failure surface: exit code + stderr.
3. **Reproducibility (SPEC NFR).** A fresh process per run holds no
   cross-run state. Byte-identical categorized CSVs stay a property of
   the inputs, not of process history.
4. **The cost is known and small.** Process start + torch import +
   checkpoint load from the local cache is seconds; inference is the
   minutes-scale part (verified facts, SPEC research). The day-1 spike
   measures the overhead explicitly; if it ever dominated, the fix is
   exactly what we've already done — batch all jobs into one invocation.

**Protocol contract** (this is the build's only cross-language API):

Request (TS → Python, stdin):

```json
{
  "jobs": ["forecast", "benchmark", "amounts"],
  "monthlyTotals": [{ "month": "2026-06", "category": "Groceries", "total": 12400.50 }],
  "debits": [{ "id": 17, "month": "2026-09", "date": "2026-09-14",
               "description": "POS-CROMA VASHI", "category": "Shopping",
               "amount": 32999, "dayOfMonth": 14, "weekday": 1,
               "merchantKey": "croma", "categoryMedian": 1800,
               "merchantMedian": 2400 }]
}
```

Response (Python → TS, stdout, exactly one object):

```json
{
  "ok": true,
  "forecast":  { "Groceries": 13150.0 },
  "benchmark": { "Groceries": 11980.0 },
  "amounts":   { "17": 3600.0 },
  "meta": { "tabpfn": "9.2.0", "checkpoint": "tabpfn-v3.5-20260909.safetensors",
            "fitSeconds": { "forecast": 41.2, "benchmark": 38.9, "amounts": 96.0 } }
}
```

…or `{ "ok": false, "error": "<one-line reason>" }` with a non-zero exit.

**Division of labour is deliberate:** Python does *only* ML — fit/predict,
raw numbers out. Every judgment (forecast-vs-naive winner, anomaly
thresholds, reason strings, "no history" notes) is computed in TS, where
it is unit-testable without Python and where the report is rendered.
TabPFN never decides what the report *says*; it only supplies predictions.

**Availability & pre-flight.** Before spawning, `tabpfn/client.ts`
checks, in order: `TABPFN_TOKEN` set → venv python exists → checkpoint
file present in the cache dir. Any miss returns a typed
`TabpfnUnavailable(reason)` *without spawning*, and the run continues
into the SPEC's degradation path (forecast/anomaly sections replaced by
explicit "unavailable because …" notes). A spawn that fails mid-job
(non-zero exit, invalid JSON, timeout) degrades the same way, with the
stderr tail as the reason. First-ever weights download happens in the
day-1 spike (network allowed at setup), so demo runs need no network;
if weights are somehow absent at run time, the download attempt fails
offline and degrades honestly — it never fabricates numbers.

**Job selection is data-driven:** `forecast`/`benchmark` are only
requested with ≥ 2 months of history (benchmark needs ≥ 3: train months
+ one held out); with a single month the worker is spawned for `amounts`
only and the forecast section prints the SPEC's insufficient-history
note. Categories absent from history are simply never predicted — TS
renders them as "no history — no forecast" (§3).

---

## 3. Decision B — Forecast shape: **one pooled regressor, category as a categorical feature**

**Decided:** a single `TabPFNRegressor` trained on *all* category-month
samples, with category as a native categorical feature — not one
regressor per category.

**The training set is a sliding construction** (one code path serves the
real forecast, the FR-9 benchmark, and nothing else):

- For each spend category *c* and each month *m* from the second month
  onward, one sample: features `{category: c (categorical), monthIndex,
  monthOfYear, lag1: total(c, m−1), rollMean: mean of total(c, m−2..m−1)
  available}`, target `total(c, m)`.
- **Forecast:** fit on all samples, predict the constructed sample for
  month *N+1* per category.
- **Benchmark (FR-9):** fit on samples with target month ≤ *N−1*,
  predict month *N*, compare per-category and overall MAE against the
  naive baseline (prediction = `total(c, N−1)`). Same builder, same
  features, one cutoff moved. The arbiter tests the exact model we ship.

**Why pooled wins here:**

1. **Sample efficiency is the whole game.** The fixture is 4 months ×
   ~13 categories ≈ 39 training samples pooled. Per-category models would
   train on **3 samples each** — below any floor where a category-specific
   model means anything; TabPFN's in-context prior cannot rescue a
   3-row training set into category-specific behaviour. Pooling shares
   structure across categories (spend level, payday rhythm, trend) while
   the categorical feature still lets categories differ.
2. **It degrades exactly the way the SPEC demands.** A category with two
   months of history still gets a pooled forecast informed by its own
   rows; a category with zero history is never in the sample space, so
   it is never predicted — TS prints "no history — no forecast" instead
   of a fabricated ₹0. Per-category models would force an ugly special
   case for every short-history category.
3. **One model = one honest benchmark.** FR-9 exists to catch
   overclaiming. A single pooled model means the benchmarked artifact
   and the shipped artifact are the same object.

**Anomaly scoring (FR-8) uses the same pooled philosophy:** one
`TabPFNRegressor` predicting a debit's *expected amount* from
`{category (cat), dayOfMonth, weekday, merchantKey (cat), categoryMedian,
merchantMedian}`, fit on all debits and predicting all debits in one
batched call (hundreds of rows — far inside the 5,000-sample CPU
guardrail). TS flags a debit when `actual > 2.5 × predicted` **and**
`actual − predicted > ₹1,000` (ratio alone flags ₹60-vs-₹20 noise; the
absolute floor alone misses mid-size categories). Flags are sorted by
ratio, capped at 10, and each reason string is built in TS from the
actual numbers ("₹32,999 at CROMA — about 9× the ~₹3,600 expected for
Shopping from its history") — a comparison, never a probability claim.

**Forecast scope:** spend (debit) categories only. `Income` appears in
aggregates and the narrative but is excluded from forecast/benchmark —
predicting a salary is not a spend forecast, and the report says so.

---

## 4. Module layout (in the existing scaffold)

```
src/
  index.ts            CLI: `report <csv> [--memory <path>] [--out <dir>]
                             [--ground-truth <path>]`
                      and `correct "<pattern>" <Category>`.
                      Stage orchestration, exit codes (0 = success incl.
                      degraded TabPFN; non-zero = fatal parse/Ollama).
  types.ts            Txn, Category, CategorizedTxn, Aggregates,
                      ForecastOutcome, Anomaly, RunMetrics, typed errors
                      (ParseError, UnrecognizedColumns, OllamaUnavailable,
                      TabpfnUnavailable)
  parse/
    csv.ts            Minimal RFC-4180 parser (quoted fields, embedded
                      commas/newlines, CRLF) — statements quote narrations
                      containing commas; no dependency does this better.
    columns.ts        Header mapping. PRIMARY: HDFC layout (Date,
                      Narration, Chq./Ref.No., Value Dt, Withdrawal Amt.,
                      Deposit Amt., Closing Balance). VARIANTS: ICICI
                      (Transaction Date / Transaction Remarks /
                      Withdrawal Amount (INR ) / …) and SBI (Txn Date /
                      Description / Debit / Credit / Balance), plus the
                      generic signed-amount shape. Returns the mapping or
                      UnrecognizedColumns listing the headers found.
    normalize.ts      Rows → Txn[]: DD/MM/YY + DD-MMM-YYYY dates, Indian
                      amount formats (1,45,000.00, Cr/Dr suffixes), sign
                      from Withdrawal/Deposit columns, exclusion of
                      non-transaction rows (opening/closing balance,
                      totals, blanks). IDs are sequential in file order —
                      deterministic, so runs are reproducible.
  categorize/
    categories.ts     The fixed category list — single source of truth:
                      Income, Rent & Housing, Groceries, Food & Dining,
                      Transport, Utilities & Bills, Subscriptions,
                      Shopping, Health & Pharmacy, Entertainment,
                      Investments, Transfers, Fees & Charges, Other.
    rules.ts          Deterministic merchant rules: ordered pattern table
                      (SWIGGY→Food & Dining, NETFLIX→Subscriptions, …).
    memory.ts         Correction memory: JSON file of
                      {pattern, category}; lookup by normalized merchant
                      key; load/save; written by the `correct` command.
    gemma.ts          Ollama client over Node 24 fetch (no npm dep):
                      health check via GET /api/tags distinguishing
                      server-down from model-missing (both errors carry
                      the exact fix commands), batched categorization
                      (temp 0, JSON-array in/out, category validated
                      against the fixed list; an invalid reply degrades
                      that row to Other and is counted in metrics),
                      narrative generation, keep_alive discipline (§1).
  aggregate.ts        Per-category totals/counts, MoM deltas, top
                      merchants, per-category median/MAD. Pure functions.
  tabpfn/
    client.ts         Pre-flight (§2), spawn, stdio JSON protocol,
                      timeout, typed TabpfnUnavailable.
  report/
    render.ts         report.md assembly — every SPEC section, including
                      degradation notes and the metrics block.
    html.ts           Purpose-built renderer for exactly the Markdown
                      subset render.ts emits (headings, tables, lists,
                      paragraphs) → one self-contained HTML file, inline
                      CSS, zero external references (the offline claim
                      extends to *viewing* the report).
    csvOut.ts         Categorized CSV: fixed column order, rows in input
                      order → byte-identical across runs (SPEC NFR).
  metrics.ts          Stage timer + accumulator: rows parsed/excluded,
                      per-stage seconds, categorization source counts,
                      model names/versions, checkpoint size.
python/
  worker.py           The three jobs of §2/§3. sklearn-style fit/predict;
                      prints exactly one JSON object to stdout.
  requirements.txt    Pinned: tabpfn==9.2.0 (+ CPU-torch install note —
                      torch comes from the CPU wheel index first, per
                      the SPEC's install-footprint NFR).
fixtures/
  statement.csv       HDFC-layout synthetic statement (§5).
  statement-icici.csv Small ICICI-layout variant — parser tests only.
  ground-truth.json   Per-row expected category, planted-anomaly row id,
                      held-out month marker (§5).
  README.md           Fixture contract: fixed reference date, stable row
                      ids, refresh semantics (regeneration never alters
                      ground truth silently).
tests/                vitest — one file per area + failure-mode tests (§7).
DEV-POST.md           The submission post, skeleton on day 2 (§8).
```

**Zero new runtime dependencies is a design goal, not an accident:**
Node 24's fetch covers Ollama; the CSV parser and HTML renderer are
small, purpose-built, and fully testable. Every dependency not taken is
a supply-chain and install-size story the post doesn't have to tell.

---

## 5. Fixture design — one believable persona, four months, HDFC layout

**Shape (locked decision):** exact HDFC export columns —
`Date, Narration, Chq./Ref.No., Value Dt, Withdrawal Amt., Deposit Amt.,
Closing Balance` — DD/MM/YY dates, comma-grouped amounts with two
decimals, HDFC narration dialects (`UPI-SWIGGY-…`, `ACH D- NETFLIX COM`,
`NEFT-…-SALARY`). Static, hand-authored file (no generator randomness):
what you read is what the demo runs.

**Story:** Jun–Sep 2026, one salaried persona. Salary ₹1,45,000 credited
on the 1st (`NEFT-HELIXWORKS TECHNOLOGIES-SALARY`); rent ₹28,000 NEFT on
the 5th; Swiggy/Zomato 8–12× a month at ₹350–₹900; BigBasket groceries;
Uber; MSEDCL electricity; Jio recharge; Netflix ₹649 + Spotify ₹149
subscriptions; a Zerodha SIP (Investments); P2P UPI transfers. ~55–70
rows/month, ≈ 250 rows total — "hundreds of rows" per the SPEC.

**Planted, on purpose:**

- **The anomaly:** a ₹32,999 `POS-CROMA VASHI-ELECTRONICS` debit in Sep,
  in a Shopping category that otherwise never exceeds ~₹3,500. It must
  appear in the report's anomaly list (SPEC acceptance) — unambiguous by
  construction, not by threshold-tuning after the fact.
- **The silent renewal:** a `ACH D-NOTION LABS` ₹999 subscription that
  starts in Aug and renews in Sep — the narrative's "renewed silently"
  beat, grounded in real aggregates.
- **The held-out month:** Sep 2026 is the FR-9 benchmark target (train
  Jun–Aug patterns → predict Sep); the shipped forecast trains Jun–Sep
  → Oct 2026. `ground-truth.json` records both markers plus the expected
  category for every row and the planted-anomaly row id.

**Reference time:** the fixture's "today" is 2026-10-01; all four months
are complete. Refreshing the fixture means editing the CSV *and*
`ground-truth.json` together — the contract in `fixtures/README.md`
says so, and the accuracy test fails loudly if they drift.

---

## 6. Error & degradation handling — every SPEC failure mode, mapped

| SPEC failure mode | Mechanism | Where it lands |
|---|---|---|
| Empty / garbage CSV | `normalize.ts` yields 0 transactions or `csv.ts` throws → fatal `ParseError` with a plain message | CLI exits non-zero, **no artifacts written** |
| Unrecognized columns | `columns.ts` finds no plausible mapping → fatal, message lists the headers found + the shapes readable (HDFC/ICICI/SBI/signed-amount) | Never a silent guess |
| Ollama down / model missing | `gemma.ts` pre-flight (`/api/tags`) before any model stage → fatal with the exact fix (`ollama serve` / `ollama pull gemma3:4b`) | Distinguishes server-down vs model-missing; no stack trace |
| TabPFN unavailable | Pre-flight or worker failure → `TabpfnUnavailable(reason)` (§2) | Report produced; forecast + anomaly sections replaced by explicit "unavailable because …" notes; never dropped, never fabricated |
| Single-month data | Job selection (§2): worker spawned for `amounts` only | Forecast section states ≥ 2 months needed; anomaly still runs within the month |
| Category with zero history | Category absent from worker samples → absent from predictions | Rendered as "no history — no forecast", never ₹0 |
| Gemma returns an invalid category mid-batch | Row-level validation in `gemma.ts` | Row falls back to `Other`; count surfaced in metrics (honesty, not silence) |
| Narrative invents a figure | Grounding check (§7) fails twice | Narrative replaced by a deterministic templated summary built from the aggregates; substitution noted in metrics |

---

## 7. Narrative grounding & the run-metrics block

**Grounding (FR-6 enforced, not hoped for).** The narrative prompt
contains *only* the aggregates JSON — totals, deltas, top merchants,
anomalies, forecast summary (or its unavailable note). After generation,
a deterministic check extracts every ₹-figure from the narrative text
and verifies each one exists in the aggregates. A failed check retries
once with a sterner prompt; a second failure substitutes a templated
summary assembled directly from the aggregates. The model proposes; the
code disposes. This is a section of the DEV post, not a footnote.

**Run-metrics block (FR-11) — designed for the post.** Writing Quality
is the top-weighted criterion, so the metrics are specified like a
feature, not an afterthought. Every report ends with:

- Rows parsed / rows excluded as non-transactions.
- Per-stage seconds: parse · rules+memory · Gemma categorize (with
  request count) · aggregate · TabPFN (spawn + per-job fit seconds from
  the worker's `meta`) · narrative · render · **total wall time**.
- Categorization source counts: memory / rule / Gemma / Other-fallback.
- Models: `gemma3:4b` via Ollama (+ Ollama version from `/api/version`),
  `tabpfn 9.2.0`, checkpoint filename + its on-disk size, Python env
  size — the install footprint the SPEC demands be reported honestly.
- Host line measured, not asserted: CPU count and total RAM from the OS
  (this VM: 2 vCPU / 7.7 GB), CPU-only.
- When `--ground-truth` is passed (fixture runs): categorization
  accuracy % and the FR-9 verdict (TabPFN MAE vs naive MAE, winner
  named) — the exact numbers the post quotes.

**Offline guarantee (SPEC acceptance).** Structural: the only
outbound-capable code paths in the build are Ollama HTTP to
`localhost:11434` and the one-time TabPFN weights download inside the
`tabpfn` library at setup. The integration test wraps a full fixture
run with a fetch/http interceptor asserting every request targets
localhost; the day-1 spike performs the downloads so the tested run
needs none.

---

## 8. Risks (top 3) and their de-risking

1. **TabPFN install + CPU inference time is unmeasured.** CPU torch
   (~200 MB wheel) through the VM's egress proxy, then checkpoint
   download, then minutes-scale inference — any leg can eat a day.
   *De-risk:* the day-1 spike (TASKS S1) does install → weights →
   200-row timing before a line of feature code exists. Kill criteria
   are written into the task; failure escalates to Pintu (Windows
   fallback per his host decision) instead of silently absorbing the
   schedule.
2. **Gemma tokens/sec on 2 vCPU makes categorization the long pole.**
   *De-risk:* rules+memory run first precisely so Gemma sees only the
   long tail; prompts are batched; the narrative is a single call. The
   day-1 spike (S2) benchmarks a categorization batch and a
   narrative-length generation on the real VM before the model choice
   is treated as locked.
3. **`TABPFN_TOKEN` depends on Pintu's license signup** (platform.
   priorlabs.ai, non-commercial TABPFN-3-5 License v1.0 — steps in
   `../TABPFN-SIGNUP-STEPS.md`). Without it there are no weights and
   the TabPFN featured category is unwinnable. *De-risk:* TASKS marks
   every token-dependent task; the degradation path (§6) means the
   rest of the build never blocks on it — but the *prize* does, so the
   signup is a day-1 ask, not a day-3 surprise.

---

## 9. Key decisions, one line each

| Decision | Choice | Why |
|---|---|---|
| Orchestration language | TypeScript (existing scaffold) | SPEC demo command, scaffold, and skills are TS; only TabPFN forces Python |
| Sidecar protocol | Spawn-per-run, JSON over stdio (§2) | Sequential residency becomes structural; zero server surface |
| Forecast shape | One pooled regressor, category as categorical (§3) | 39 pooled samples beat 13 models × 3 samples; benchmark = shipped model |
| ML/judgment split | Python predicts, TS judges | Thresholds/reasons/verdicts unit-testable without Python |
| Ollama access | Raw HTTP via Node fetch, no SDK | One less dependency; the API surface used is three endpoints |
| CSV parsing | Hand-rolled RFC-4180 | Quoted narrations + Indian formats under full control; tiny, testable |
| Correction memory | Human-editable JSON file | Diffable, no DB, survives runs; FR-4 with no retraining step |
| HTML report | Purpose-built mini-renderer, inline CSS | Self-contained file, zero external refs — offline claim holds for viewing too |
| Fixture | Static HDFC-layout CSV + ground-truth JSON | Hand-verifiable; the demo's credibility *is* the fixture's realism |
