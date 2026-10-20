# Fixture contract — Ledger Sloth

The fixture is the demo's credibility: one believable salaried persona,
four complete months (Jun–Sep 2026) of an HDFC Bank statement, authored
by hand as a static file. What you read is exactly what the demo runs.

## Files

| File | Role |
|---|---|
| `statement.csv` | Primary fixture — exact HDFC export layout: `Date, Narration, Chq./Ref.No., Value Dt, Withdrawal Amt., Deposit Amt., Closing Balance`, DD/MM/YY dates, Indian-grouped amounts (`1,45,000.00`). 249 transactions + 2 non-transaction rows (an Opening Balance line at the top, a Closing Balance line at the bottom). |
| `statement-icici.csv` | Small ICICI-layout variant (10 transactions) — parser tests only. |
| `ground-truth.json` | The expected category for **every** transaction row, the planted-anomaly row id, totals, and the benchmark markers below. |

## Row ids

Row ids are the parser's sequential transaction ids: 1-based, in file
order, assigned to transaction rows only. Non-transaction rows
(opening/closing balance) receive **no** id. `ground-truth.json`'s
`rows[].id` refers to exactly these ids, so the accuracy test and the
anomaly check can address any row unambiguously.

## Reference time and benchmark markers

- The fixture's "today" is **2026-10-01**; all four months are complete.
- **Held-out month: Sep 2026** (`heldOutMonth`) — the FR-9 benchmark
  trains on Jun–Aug patterns and predicts Sep.
- **Forecast target: Oct 2026** (`forecastTargetMonth`) — the shipped
  forecast trains on Jun–Sep.
- **Planted anomaly: row id 220** (`plantedAnomalyRowId`) — a ₹32,999
  `POS-CROMA VASHI-ELECTRONICS` debit on 14/09/26, in a Shopping
  category that otherwise never exceeds ~₹3,500. It must appear in the
  report's anomaly list (SPEC acceptance criterion).
- **Silent renewal beat:** `ACH D- NOTION LABS INC` ₹999 starts
  12/08/26 and renews 12/09/26 — the narrative's "renewed silently"
  example, grounded in real aggregates.

## Refresh semantics (read before editing)

The CSV and `ground-truth.json` are edited **together, always**. Adding,
removing, or reordering a transaction row changes every later row id
and invalidates the ground truth; the categorization-accuracy test
fails loudly if the two drift apart. Never regenerate one without the
other, and never alter ground truth silently to make a number pass —
the measured accuracy, whatever it is, is what the DEV post reports.
