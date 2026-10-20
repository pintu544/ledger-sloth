# DEV-POST.md — Ledger Sloth (Hacktoberfest Week 3 submission draft)

> Skeleton (S8). Slots marked `[[SLOT: …]]` stay EMPTY until the number
> is measured — S14 fills them from the run metrics and spec/research.md.
> Claims discipline: Gemma and TabPFN are "open-weight", never
> "open-source"; the forecast verdict is reported win-or-lose.

---

## Title

**Ledger Sloth: a bank statement reader that never phones home** 🦥

_Submitted to the DEV × MLH Hacktoberfest Week 3 challenge ("Slow and
Steady"). Built for the Best Use of TabPFN and Best Use of Gemma
featured categories._

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

- [[SLOT: one-paragraph feature summary, written at S14 from the final CLI]]
- Categorizes every transaction (memory → rules → Gemma — see below).
- Flags anomalous charges with reasons built from your own history.
- Forecasts next month's per-category spend with TabPFN — and tells
  you, honestly, whether that forecast beat the naive guess
  (see "The honest benchmark").

## Architecture — two models, never in the room together

[[SLOT: diagram or screenshot of the pipeline, S14]]

The pipeline is a straight line, and its shape *is* the privacy
story:

1. **Parse.** A hand-rolled RFC-4180 reader maps the statement's
   columns (HDFC layout first; ICICI and SBI variants too) into
   typed transactions. Unrecognized layouts fail loudly, listing the
   headers found — never a silent guess.
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
   swapping to death.
6. **Narrate.** Gemma returns for one call whose prompt contains
   *only* the aggregates. Every ₹-figure it writes is then checked
   against those aggregates; invent one, and the narrative is
   retried once, then replaced by a templated summary. The model
   proposes; the code disposes.
7. **Render.** `report.md`, a self-contained `report.html` (zero
   external references — the offline claim holds even when you
   *view* the report), and `categorized.csv`, byte-identical across
   runs.

## Why open — bank statements are data you never upload

[[ESSAY DRAFT — tighten at S14]]

There is a short list of documents that describe a life almost
completely: a month of bank transactions is on it. Salary, rent,
medicines, the 2 a.m. food orders, the loan you're quiet about —
it's all there, timestamped. Tools that analyze statements almost
always ask you to upload that document to someone else's server,
where "analysis" means it joins a database you can't see, under a
privacy policy you'll never read.

Open-weight models change who can build this tool. Gemma 3 runs on
the laptop that already holds the statement. TabPFN — a foundation
model for tabular data — runs the forecast locally after a one-time
weights download. Nothing in Ledger Sloth's design *requires* a
server, an account, or a network: after setup, the only HTTP it
makes is to `localhost`. That's not a privacy *policy*; it's an
architecture. You don't have to trust it — you can watch it work
with the Wi-Fi off.

And the local part compounds. Your corrections ("no, that transfer
is rent, not shopping") live in a JSON file on your disk, making
next month's run better without a single byte leaving the machine.
Open weights make this *possible*, not just cheaper: a hosted API
version of Ledger Sloth would be a different, worse product wearing
the same name.

## The honest benchmark

TabPFN's forecast is only worth having if it beats the forecast a
spreadsheet makes for free: *next month = this month*. So Ledger
Sloth benchmarks itself on your oldest held-out month — same model,
same features, cutoff moved — and prints the verdict either way.

[[SLOT: FR-9 verdict (S10) — TabPFN MAE vs naive MAE, per-category and overall, winner named, stated win-or-lose]]

## Numbers (all measured, none estimated)

- Spike, TabPFN install + 200-row fit/predict + checkpoint size: [[SLOT: S1 numbers]]
- Spike, Gemma load / tokens-per-second / unload: [[SLOT: S2 numbers]]
- Rows the deterministic layer (memory + rules) settles without the model: [[SLOT: S5 rules coverage]]
- Categorization accuracy vs ground truth: [[SLOT: S12 accuracy]]
- Full-run per-stage timings: [[SLOT: S12 timings]]
- Total install footprint (venv, checkpoint, model): [[SLOT: S12 disk footprint]]
- Host this was measured on: [[SLOT: host line from run metrics]]

## What it doesn't do (yet)

- PDF statements — CSV exports only, for now.
- Bank connections or syncing — by design; you bring the file.
- [[SLOT: anything S13's adversarial QA surfaces as a known limit]]

## Claims discipline — my own checklist

- [ ] "Open-weight" used for Gemma (Gemma Terms) and TabPFN
      (TABPFN-3-5 License v1.0, non-commercial) — never "open-source"
      for either model. Package code credited accurately
      (tabpfn is Apache 2.0).
- [ ] TabPFN license line present (weights © Prior Labs, used under
      the non-commercial license).
- [ ] Every number in this post traces to a measured run — no
      estimates dressed as results.
- [ ] FR-9 verdict stated win-or-lose, with both MAEs.
- [ ] No forecast claim beyond what the fixture benchmark showed.
- [ ] Privacy claim worded structurally ("no network after setup"),
      not as a promise about other people's servers — there are none.

## Try it

[[SLOT: repo link + the 3-command quickstart (clone, pull gemma3:4b, one-time TabPFN weights, run the fixture) — written at S14 once S13 QA passes]]
