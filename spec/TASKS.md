# TASKS — Ledger Sloth (DEV × MLH Hacktoberfest Week 3, "Slow and Steady")

> Ordered checklist. One task = one verifiable unit (≤ half a day). Check
> off only when its acceptance criteria pass. Requirements: `SPEC.md`;
> architecture + the two resolved decisions: `DESIGN.md` §2 (spawn-per-run
> sidecar) and §3 (one pooled regressor).
>
> **Deadline:** Oct 25, 23:59 UTC. **Plan: submit Oct 24.** Build days:
> Oct 21 (day 1) → Oct 24 (day 4).
>
> 🔑 = depends on **`TABPFN_TOKEN`** existing (Pintu's license signup at
> platform.priorlabs.ai — `../TABPFN-SIGNUP-STEPS.md`). Token-dependent
> tasks block only the TabPFN path; the SPEC degradation path means
> nothing else waits on it.
>
> **Day-1 spikes come first because they can kill the concept.** If a
> spike hits its kill criterion, STOP and escalate to Pintu the same
> day — do not absorb it into the schedule.

## Spike slice — Day 1 (Oct 21): prove the two models on the real VM

- [x] **S1 🔑 — TabPFN spike: install, weights, 200-row timing.**
  CPU-only torch from the CPU wheel index *first* (never the CUDA
  build), then `tabpfn==9.2.0` in a venv; with `TABPFN_TOKEN` set,
  trigger the one-time TabPFN-3.5 checkpoint download; fit a
  `TabPFNRegressor` on 200 synthetic rows and time fit+predict; record
  peak RSS and total disk (venv + checkpoint).
  *Done means:* numbers written to `spec/research.md` (install time,
  checkpoint size, venv size, fit+predict seconds, peak RSS).
  *Kill criterion:* install irrecoverable through the VM proxy, or
  200-row fit+predict > ~10 min → escalate to Pintu (Windows fallback).
  *Partial completion:* install + timing with a stand-in checkpoint is
  acceptable if only the token is missing — record that the weights
  download is still pending 🔑.
  *Unblocks:* S9, S10.

- [x] **S2 — Ollama spike: install, pull, tokens/sec benchmark.**
  Install Ollama on the VM (no systemd — run `ollama serve` as a
  background process; document the exact command), `ollama pull
  gemma3:4b`, then benchmark on the real VM: one categorization-style
  batch prompt and one narrative-length (~400 token) generation;
  measure load time, tokens/sec, unload behaviour with `keep_alive: 0`,
  and peak RSS.
  *Done means:* numbers in `spec/research.md`; serve/pull commands
  documented for the README.
  *Kill criterion:* narrative-length generation > ~5 min → escalate to
  Pintu before the model choice is treated as locked.
  *Unblocks:* S6, S11.

## Slice 1 — Day 1–2 (Oct 21–22): fixture + parser (CSV in → Txn[] out)

- [x] **S3 — Fixture authoring (HDFC layout, ground truth, contract).**
  Author `fixtures/statement.csv` per DESIGN §5: exact HDFC columns
  (Date, Narration, Chq./Ref.No., Value Dt, Withdrawal Amt., Deposit
  Amt., Closing Balance), Jun–Sep 2026, ~250 rows, salary/rent/UPI/
  Swiggy/Zomato/subscriptions story, planted ₹32,999 CROMA anomaly,
  Notion silent-renewal beat. Plus `fixtures/statement-icici.csv`
  (small ICICI-layout variant, parser tests only), `fixtures/
  ground-truth.json` (expected category per row, planted-anomaly row
  id, held-out month = Sep 2026), `fixtures/README.md` (contract:
  reference date 2026-10-01, stable row ids, refresh semantics).
  *Done means:* fixture reads as a believable HDFC statement; ground
  truth covers every row; CSV + ground truth edited-together rule is
  written in the contract.
  *Unblocks:* S4, S5, S7, and every accuracy measurement.

- [x] **S4 — Parser: CSV → columns → normalized Txn[].**
  `parse/csv.ts` (RFC-4180), `parse/columns.ts` (HDFC primary; ICICI +
  SBI variants; generic signed-amount shape; `UnrecognizedColumns`
  listing found headers), `parse/normalize.ts` (dates, Indian amount
  formats, sign from Withdrawal/Deposit, non-transaction exclusion,
  sequential ids).
  *Done means:* vitest green — fixture parses to the exact expected
  transaction count with the expected exclusion count; ICICI variant
  parses through the mapping; empty/garbage input and
  unrecognized-columns tests demonstrate the SPEC failure behaviour
  (plain message, no artifacts).
  *Unblocks:* S5, S7.

## Slice 2 — Day 2 (Oct 22): categorization + aggregates (categorized CSV out)

- [ ] **S5 — Categories, rules, correction memory.**
  `categorize/categories.ts` (fixed list, DESIGN §4), `rules.ts`
  (ordered merchant pattern table), `memory.ts` (JSON load/save,
  merchant-key lookup), `correct "<pattern>" <Category>` CLI
  subcommand (validates against the fixed list).
  *Done means:* unit tests pass; rules+memory alone run over the
  fixture and their coverage % (rows categorized without Gemma) is
  measured and recorded in `spec/research.md` — the number the post
  cites for why the slow model stays a long-tail tool.
  *Unblocks:* S6, S7.

- [ ] **S6 — Gemma categorizer (Ollama client).**
  `categorize/gemma.ts`: pre-flight via `/api/tags` (server-down vs
  model-missing, both failing with the exact fix commands — no stack
  trace), batched categorization of leftover rows (temp 0, JSON-array
  contract, category validated against the fixed list, invalid →
  `Other` + metrics count), `keep_alive: 0` on the stage's final
  request.
  *Done means:* with Ollama running, fixture leftovers all end with
  exactly one valid category; with Ollama stopped, the CLI fails with
  the exact fix commands (test asserts the message); source counts
  (memory/rule/gemma/other) appear in metrics.
  *Unblocks:* S12 (full pipeline).

- [ ] **S7 — Aggregates + categorized CSV writer.**
  `aggregate.ts` (per-category totals/counts, MoM deltas, top
  merchants, median/MAD) and `report/csvOut.ts` (fixed columns, input
  order).
  *Done means:* aggregates for one fixture month match hand-computed
  expected values in a test with literal numbers; two runs of the CSV
  writer produce byte-identical output (test).
  *Unblocks:* S9 (worker consumes monthly totals), S11, S12.

- [ ] **S8 — DEV post skeleton (day 2, parallel with Slice 2).**
  `DEV-POST.md`: title, the dreaded-monthly-chore hook, architecture
  (DESIGN §1 diagram in words), the why-open essay draft (bank
  statements are data you never upload; open weights make this
  *possible*, not just cheaper), claims-discipline checklist
  (Gemma/TabPFN = "open-weight", license lines, benchmark reported
  win-or-lose), and empty slots labelled for: spike numbers (S1/S2),
  rules coverage (S5), accuracy (S12), FR-9 verdict (S10), timings +
  disk footprint (S12).
  *Done means:* skeleton exists with every section and slot; no
  numbers invented — slots stay empty until measured.
  *Unblocks:* S14.

## Slice 3 — Day 3 (Oct 23): TabPFN forecast + anomaly + honest benchmark

- [ ] **S9 🔑 — Python worker + TS client.**
  `python/worker.py` (the three jobs of DESIGN §2/§3: pooled-regressor
  forecast, benchmark predictions at the moved cutoff, per-debit
  amount predictions; exactly one JSON object on stdout) +
  `python/requirements.txt` (pinned tabpfn 9.2.0, CPU-torch note) +
  `tabpfn/client.ts` (pre-flight: token → venv → checkpoint; spawn;
  timeout; typed `TabpfnUnavailable`).
  *Done means:* worker round-trip on the fixture's monthly totals
  returns forecasts for every category with history; a zero-history
  category is absent from predictions (never ₹0); a single-month
  request returns the forecast-skipped marker with `amounts` still
  served.
  *Unblocks:* S10.

- [x] **S10 🔑 — Benchmark + anomaly integration (TS-side judgment).**
  FR-9 verdict computed in TS from worker predictions (TabPFN MAE vs
  naive MAE on held-out Sep 2026, per-category + overall, winner
  named); anomaly flagging per DESIGN §3 thresholds (ratio > 2.5×
  *and* gap > ₹1,000), sorted, capped at 10, reason strings built
  from the actual numbers.
  *Done means:* vitest green including — planted CROMA anomaly
  appears in the anomaly list; benchmark result prints verbatim in a
  demo run; TabPFN-unavailable test (token/weights removed) shows
  both sections replaced by explicit "unavailable because …" notes
  with the report still produced; single-month test shows the
  insufficient-history note with anomaly still running.
  *Unblocks:* S11, S12.

## Slice 4 — Day 3–4 (Oct 23–24): narrative + report (the SPEC demo, end to end)

- [x] **S11 — Narrative with grounding enforcement.**
  `gemma.ts` narrative path: prompt contains ONLY the aggregates JSON
  (totals, deltas, top merchants, anomalies, forecast summary or its
  unavailable note); post-generation ₹-figure extraction check
  against the aggregates; one sterner retry; then deterministic
  templated summary as fallback, noted in metrics.
  *Done means:* test with a stubbed Ollama returning an invented
  figure triggers the retry/fallback path; a real run's narrative
  contains only figures present in the aggregates.
  *Unblocks:* S12.

- [x] **S12 — Report rendering + run-metrics + full CLI.**
  `report/render.ts` (every SPEC section incl. degradation notes and
  the FR-11 metrics block of DESIGN §7), `report/html.ts`
  (self-contained, zero external references), `metrics.ts`, CLI
  wiring in `index.ts` (`report` command, `--ground-truth` accuracy
  computation).
  *Done means:* the SPEC demo command — `npx tsx src/index.ts report
  fixtures/statement.csv` — runs end to end and writes report.md,
  report.html, categorized.csv; report contains every SPEC section;
  HTML test asserts no external asset references; metrics block is
  complete (per-stage seconds, source counts, model names/versions,
  checkpoint size, host line); fixture categorization accuracy is
  computed and printed (target ≥ 85%; the measured number, whatever
  it is, is what the post gets).
  *Unblocks:* S13, S14.

## Slice 5 — Day 4 (Oct 24): adversarial QA + submission

- [x] **S13 — Failure-mode sweep, offline test, adversarial QA.**
  Every SPEC failure mode has a passing test (checklist against
  SPEC's list, one by one); offline-structure integration test (full
  fixture run behind a fetch/http interceptor asserting localhost-only
  traffic); reproducibility test (two full runs → byte-identical
  categorized CSV). Then a **fresh-subagent adversarial QA pass**
  (skill rule: never QA your own slice) over the whole build —
  malformed CSVs, hostile narrations, huge inputs (10k rows),
  memory-file corruption, worker timeouts. Fix every critical before
  this slice closes; warnings at builder's judgment.
  *Done means:* `npx vitest` + `npx tsc --noEmit` green; QA report
  filed in the goal workspace; zero open criticals.
  *Unblocks:* S14.

- [x] **S14 — Fill the post with measured numbers + submit (Oct 24).**
  Complete `DEV-POST.md` from the S8 skeleton: spike timings, rules
  coverage, categorization accuracy, **FR-9 verdict stated win or
  lose**, per-stage timings, install/disk footprint, screenshots of
  report.html; final claims-discipline re-read (open-weight wording,
  TabPFN license line, no forecast claim beyond the fixture
  benchmark). Publish on DEV as the Hacktoberfest Week 3 challenge
  submission, entering **Best Use of TabPFN** and **Best Use of
  Gemma**.
  *Done means:* post is live, submission confirmed on the challenge
  page, confirmation captured. Submit Oct 24 — a full day ahead of
  the Oct 25, 23:59 UTC deadline.
