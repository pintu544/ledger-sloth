---
title: "Ledger Sloth: a bank statement reader that never phones home"
published: false
description: "A local-only CLI that categorizes a bank statement CSV, forecasts next month with TabPFN, flags anomalous charges, and writes a figure-checked month-in-review with Gemma — and then honestly reports that the naive baseline beat its forecast."
---

*Submitted to the DEV × MLH Hacktoberfest Week 3 challenge ("Slow and
Steady"), for the Best Use of TabPFN and Best Use of Gemma featured
categories.*

## The hook — the chore everyone dreads, monthly

Once a month, the statement lands. A few hundred lines of bank-speak —
`ACH D- ZERODHA BROKING SIP`, `UPI-SWIGGY-BANGALORE`, a ₹999 charge
from a tool you trialled in August and forgot by September. Somewhere
in there is the answer to "where did the money go?", and getting it
out means an evening with a spreadsheet, or uploading the most
revealing document you own to a website and hoping.

Ledger Sloth is the lazy way out — appropriately, for International
Sloth Day. Point it at the statement CSV your bank already gives you:

```bash
npx tsx src/index.ts report statement.csv
```

It reads every transaction, categorizes it, and writes a
month-in-review: where the money went, what changed versus last
month, which subscriptions renewed silently, which charges look
wrong — plus a forecast of next month's spending per category, and a
categorized CSV for your records. It runs at CPU speed, on your
machine, and it is in no hurry. Neither are you. That's the point.

## What it does

One command takes one statement CSV (HDFC layout first; ICICI and SBI
variants and a generic signed-amount shape too) and produces three
files in an output folder: `report.md`, a self-contained
`report.html`, and `categorized.csv` — every transaction with its
category, ready for a spreadsheet or an accountant. In between,
every row is parsed and normalized; categorized by a local correction
memory, then deterministic rules, then Gemma; aggregated into
per-category totals and month-over-month deltas; scored by TabPFN,
which forecasts next month per category and scores every debit
against what it expected that charge to be; and written up by Gemma
into a plain-English month-in-review whose every rupee figure is
mechanically checked against the computed aggregates before it is
allowed into the report.

- Categorizes every transaction (memory → rules → Gemma — see below).
- Flags anomalous charges with reasons built from your own history.
- Forecasts next month's per-category spend with TabPFN — and tells
  you, honestly, whether that forecast beat the naive guess
  (see "The honest benchmark").
- Learns your corrections locally: `correct "NOTION LABS" Subscriptions`
  writes one line to a JSON file on your disk, and that merchant is
  yours forever — no retraining, no account, no sync.

## Architecture — two models, never in the room together

```
statement.csv
     │
     ▼
 parse ──► categorize ──► aggregate ──► TabPFN worker ──► narrate ──► render
 (TS)      memory → rules   (pure TS)    (Python, spawned   (Gemma —    report.md
            → Gemma (Ollama)              once, one JSON     figures    report.html
                                          job, then exits)   checked)   categorized.csv
```

The pipeline is a straight line, and its shape *is* the privacy
story:

1. **Parse.** A hand-rolled RFC-4180 reader maps the statement's
   columns into typed transactions. Unrecognized layouts fail loudly,
   listing the headers found — never a silent guess.
2. **Categorize, deterministic first.** A local correction memory
   (your teachings, in a JSON file you can read and edit) and an
   ordered merchant-rule table categorize everything they know —
   instantly, offline, explainably.
3. **Categorize, Gemma for the long tail.** Whatever is left goes, in
   batches, to **Gemma 3 4B running locally via Ollama**. Replies are
   validated — exact length, categories checked against the fixed
   list — before a single row is mapped; anything invalid degrades
   to `Other` and is counted, in the open, in the run metrics.
   The stage's last request unloads the model.
4. **Aggregate.** Totals, month-over-month deltas, top merchants,
   medians — pure functions, unit-tested against hand-computed values.
5. **Forecast + anomaly scoring with TabPFN.** A separate Python
   process is spawned once, handed one JSON job (forecast, honest
   benchmark, expected amounts), and exits — so PyTorch and Gemma
   are *never resident at the same time*. On a small machine that
   isn't an optimization; it's the difference between running and
   swapping to death. On the 7.7 GB box this was built on, Gemma
   peaks at 3,773 MB and TabPFN at 3,933 MB — comfortable one at a
   time, impossible together.
6. **Narrate.** Gemma returns for one call whose prompt contains
   *only* the aggregates. Every ₹-figure it writes is then checked
   against those aggregates — it must exist, be written in
   well-formed digit grouping, and be used in the right scope
   (see "Grounding the narrator"). Fail, and the narrative is
   retried once, then replaced by a templated summary — and the
   report says so, in the report. The model proposes; the code
   disposes.
7. **Render.** `report.md`, a self-contained `report.html` (zero
   external references — the offline claim holds even when you
   *view* the report), and `categorized.csv`, byte-identical across
   runs — I verified that across four full runs, including one with
   no network at all.

## Why open — bank statements are data you never upload

There is a short list of documents that describe a life almost
completely: a month of bank transactions is on it. Salary, rent,
medicines, the 2 a.m. food orders, the loan you're quiet about —
it's all there, timestamped. Tools that analyze statements almost
always ask you to upload that document to someone else's server,
where "analysis" means it joins a database you can't see, under a
privacy policy you'll never read.

Open-weight models change who can build this tool. **Gemma 3**
(open-weight under the Gemma Terms of Use) runs on the laptop that
already holds the statement. **TabPFN** — a foundation model for
tabular data — runs the forecast locally after a one-time weights
download: the TabPFN-3.5 weights are open-weight under Prior Labs'
non-commercial TABPFN-3-5 License v1.0, and the `tabpfn` package
code itself is Apache 2.0. Nothing in Ledger Sloth's design
*requires* a server, an account, or a network: after setup, the only
HTTP it makes is to `localhost`. That's not a privacy *policy*; it's
an architecture. You don't have to trust it — you can watch it work
with the Wi-Fi off. I did: a full run inside a network namespace
with no egress route at all (a `curl` to the outside fails)
completed with the identical benchmark verdict and identical
output.

And the local part compounds. Your corrections live in a JSON file
on your disk, making next month's run better without a single byte
leaving the machine. The cost structure is a consequence of the
openness too: after the one-time downloads, a run costs ₹0 — no API
bill scales with your bank history. Open weights make this
*possible*, not just cheaper: a hosted API version of Ledger Sloth
would be a different, worse product wearing the same name.

## The honest benchmark

TabPFN's forecast is only worth having if it beats the forecast a
spreadsheet makes for free: *next month = this month*. So Ledger
Sloth benchmarks itself on a held-out month — same model, same
features, cutoff moved — and prints the verdict either way.

On the fixture statement (four months, Jun–Sep 2026; Sep held out;
12 spend categories), the verdict is:

**The naive baseline won — naive MAE ₹2,558.75 vs TabPFN MAE
₹2,806.45.**

Why, honestly: this household is metronome-stable. Rent is ₹28,000
every month, investments ₹10,000, food within a few hundred rupees.
Repeating last month scores *zero* error on five categories and
under ₹200 on six more. The only row where either model was badly
wrong was Shopping — September's actual (₹36,147) contains the
planted anomaly, and both models missed it by ~₹30,000. One held-out
month and 12 categories is a small sample, and the report says that
too; this verdict describes this statement's benchmark, not TabPFN
in general.

What TabPFN's predictions looked like anyway: on the big steady
categories they were genuinely close — rent ₹28,004.74 against an
actual ₹28,000 (off by ₹4.74), food & dining ₹14,828.06 against
₹14,641 (off by ₹187), transport within ₹188. It lost on the small
jumpy categories (utilities, entertainment), where it predicted
rises that didn't happen, and on the anomaly row, where both models
were equally blindsided. With three training months, "close but not
closest" is the true result — so the forecast is the part of this
tool I make the *smallest* claim for. Where TabPFN earned its place
is the next section.

The same rawness applies to the forecast itself: next month's
Shopping forecast prints as ₹82,866.32, because the model trained on
the anomaly month as-is. The report shows it unadjusted, with a
note naming the flagged charge — rather than quietly cleaning the
input to make the model look smarter.

## The anomaly that almost got away

The anomaly detector scores each debit against a TabPFN model of
expected amounts. The fixture plants one charge that must be caught:
₹32,999 at CROMA on 2026-09-14, in a Shopping history whose category
median is ₹1,774. The flag rule is conservative — actual must exceed
2.5× the expected amount *and* the gap must exceed ₹1,000.

The first working version expected ₹21,834 for that charge — a ratio
of 1.51×. No flag. The detector missed the one charge it existed to
catch, and the reason was a leak, not the model: the
`merchantMedian` feature for a merchant that occurs exactly once
*is that charge's own amount*. The feature contained the answer.

Fix one: leave-one-out merchant medians — the median of the
merchant's *other* debits, falling back to the category median. The
expected amount barely moved: ₹20,294 (1.63×). Because the second
leak was subtler: TabPFN is an in-context learner, and the scoring
protocol fit on all debits and predicted the same rows — the CROMA
row sat in its own training context, under a merchant key that
occurs once, pulling its prediction toward itself.

Fix two: the amounts job is now 5-fold cross-fitted inside the
worker — every debit is predicted only by a model fit on the other
folds. A charge is never scored by a model that saw it. Expected
amount for CROMA: **₹1,938.50 — so ₹32,999 flags at ~17× expected,
a gap of ~₹31,061**, with the reason printed in the report. It is
the only flag on the fixture, which is also correct: nothing else
in four months deserved one. An anomaly detector graded on its own
homework will pass every exam and catch nothing; cross-fitting is
what makes the flag mean something.

## Grounding the narrator

The narrative is the one place a language model writes prose about
your money, so it is the place the design trusts it least. Gemma
sees only the aggregates JSON — never the statement — and every
₹-figure in its draft is extracted and checked before the draft is
accepted. The first version checked only that figures *exist* in the
aggregates. My adversarial QA pass caught why that's not enough:
one draft wrote of Shopping "a significant increase of ₹52,740" —
₹52,740 is real, but it's Shopping's *whole-period* total;
September's actual month-over-month change was +₹30,148. Right
number, wrong scope, false sentence. Another run produced a correct
total with mangled digit grouping ("₹11,1622").

Grounding is now three checks: a figure must exist in the payload,
be written in well-formed grouping, and be used in its proper scope
— whole-period figures only with whole-period framing. Failures get
one sterner retry, then the deterministic template takes over, and
the substitution is disclosed in the report body and the run
metrics. On the final verification run before writing this post,
both Gemma drafts failed on genuinely bad figures — an invented
₹52,747, per-category errors the model derived itself, a ×10 slip
(₹11,20,000) — and the report shipped the template instead: plainer,
correct, and labelled as a template. The trade-off is real and I'll
state it: stricter grounding means more fallbacks, and a failed
attempt costs another generation (that run's narrative stage took
347 s; the whole run 6 min 45 s against just under four minutes
when a draft grounds first try). The report is never wrong. At
worst, it's plainer.

## Numbers (all measured, none estimated)

Measured on the build host: 2 vCPU · 7.7 GB RAM · CPU-only, no GPU
(Ollama 0.40.6, tabpfn 9.2.0, torch 2.14.1+cpu, Python 3.12.3,
Node 24).

- **TabPFN spike:** CPU-only torch installed in 84 s; `tabpfn`
  in 235 s; TabPFN-3.5 checkpoint 876 MB, downloaded once, offline
  after; a 200-row fit+predict took 38.7 s at 3,933 MB peak RSS.
- **Gemma spike:** model load 36.6 s; categorization at
  6.64 tokens/s; narrative generation at 6.57 tokens/s (267 tokens
  in 57.6 s); peak RSS 3,773 MB; `keep_alive: 0` unload verified
  (server RSS falls to 34 MB afterwards).
- **Categorization:** the deterministic layer (memory + rules)
  settled **249/249 rows (100%)** of the fixture with zero leftovers
  — the fixture persona runs on 28 regular narration templates, and
  the post should be honest that the rules, not the model, carry
  this number. Gemma alone, verified live: 23/25 (92.0%) on a sample
  of real narrations, and 8/8 on synthetic merchants the rules had
  never seen (Zudio, Bikanervala, Dr Lal PathLabs, Kalyan Jewellers…).
  **Accuracy vs ground truth on the full pipeline: 249/249 = 100.0%**
  (the target was ≥85%). Source counts print in every report —
  on the fixture: memory 0 · rule 249 · Gemma 0 · Other 0.
- **TabPFN on the fixture:** one worker run does all three jobs —
  in the demo run, 57.9 s total (forecast fit 17.0 s, benchmark
  2.3 s, amounts 37.1 s cross-fitted), scoring all 243 debits and
  forecasting exactly the 12 categories with history. A category
  with no history gets "no history — no forecast", never a
  fabricated ₹0.
- **Full run:** just under four minutes when the narrative grounds
  on the first attempt (233 s of stage time; the narrative stage
  alone was 169 s of it); 6 min 45 s on the run where both drafts
  failed grounding and the disclosed template took over. The
  categorized CSV came out byte-identical in both — and in the
  offline run.
- **Install footprint:** Python env 1,328.6 MiB + TabPFN-3.5
  checkpoint 835.4 MiB + gemma3:4b 3.4 GB — about 5.5 GB of disk,
  once.
- **Tests:** 149 passing, covering the parser, rules, grounding
  checks, worker protocol, failure modes, and the
  byte-identical-output guarantee.

## Failure modes are features here

Each of these was exercised end-to-end, not just unit-tested:

- **TabPFN unavailable** (no token, no weights): the report is still
  produced, with the forecast and anomaly sections replaced by an
  explicit "unavailable because…" note. Nothing silently dropped,
  nothing invented.
- **A single month of data:** the forecast section states that at
  least two months of history are needed and extrapolates nothing.
  Anomaly scoring still runs within the month — CROMA flags there
  too, at ~22× its expected amount.
- **Ollama not running:** the run fails fast with the exact fix
  command (`ollama serve`) and produces zero partial artifacts.
- **Garbage or unrecognized CSV:** a plain failure message — for
  unknown layouts, listing the headers found and the shapes Ledger
  Sloth can read. No artifacts, no guessing.
- **Zero outbound calls:** after the one-time setup downloads, a
  full run needs no network at all (verified with no egress route,
  above).

## What it doesn't do (yet)

- PDF statements — CSV exports only, for now.
- Bank connections or syncing — by design; you bring the file.
- Long histories: the benchmark above is three training months, and
  on short, stable histories the naive baseline is genuinely hard
  to beat. The forecast should get *more* useful with a year of
  statements; I haven't measured that, so I won't claim it.
- The narrative sometimes ships as the templated summary — by
  design, disclosed when it happens (see "Grounding the narrator").
- Layouts beyond HDFC, ICICI, SBI and the generic signed-amount
  shape will fail loudly rather than parse creatively.

## Try it

```bash
git clone [[SLOT: repo URL — added at publish]] ledger-sloth
cd ledger-sloth
npm install

# Python sidecar: CPU-only torch FIRST (avoids the multi-GB CUDA build)
python3 -m venv python/.venv
python/.venv/bin/pip install torch==2.14.1 --index-url https://download.pytorch.org/whl/cpu
python/.venv/bin/pip install -r python/requirements.txt   # tabpfn==9.2.0

ollama pull gemma3:4b
# one-time: accept the TabPFN-3.5 license at platform.priorlabs.ai,
# copy the token from your account page, then:
export TABPFN_TOKEN=<your token>

ollama serve &   # if it isn't already running
npx tsx src/index.ts report fixtures/statement.csv
```

The demo statement is synthetic (a salaried persona, Jun–Sep 2026,
one planted anomaly) with published ground truth, so every number
in this post can be checked by hand. Slow, local, and in no hurry —
that's the whole idea. 🦥

---

## Author's pre-publish checklist (not part of the post)

- [x] "Open-weight" used for Gemma (Gemma Terms) and TabPFN
      (TABPFN-3-5 License v1.0, non-commercial) — never "open-source"
      for either model. Package code credited accurately
      (tabpfn is Apache 2.0).
- [x] TabPFN license line present (weights © Prior Labs, used under
      the non-commercial license).
- [x] Every number in this post traces to a measured run — no
      estimates dressed as results.
- [x] FR-9 verdict stated win-or-lose, with both MAEs.
- [x] No forecast claim beyond what the fixture benchmark showed.
- [x] Privacy claim worded structurally ("no network after setup"),
      not as a promise about other people's servers — there are none.
- [ ] Repo URL slotted into "Try it" at publish time (Oct 24).
