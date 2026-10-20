// TS-side judgment over the worker's raw predictions (DESIGN §2/§3):
// Python predicts, TS decides. This module owns the FR-9 benchmark
// verdict and the FR-8 anomaly flags — thresholds, winner, and reason
// strings live here, unit-testable without Python or TabPFN.

import { totalsGrid, type DebitFeatures, type TabpfnResult } from "./client.js";
import { fmtINR, fmtRatio } from "../format.js";
import type { Aggregates, Anomaly, BenchmarkVerdict, CategoryBenchmark } from "../types.js";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** DESIGN §3 flag rule: BOTH conditions, so neither a large ratio on
 * a tiny charge nor a large absolute gap on a huge routine charge
 * (rent drifting up) flags alone. */
export const ANOMALY_RATIO = 2.5;
export const ANOMALY_MIN_GAP = 1000;
export const ANOMALY_CAP = 10;

/**
 * FR-9: score the worker's benchmark predictions for the held-out
 * last month against the naive baseline (prediction = the previous
 * month's total). Returns null when there is nothing to judge
 * (no benchmark predictions — fewer than 3 months of history).
 * The verdict is computed, never framed: win or lose, the MAEs are
 * what they are (SPEC claims discipline).
 */
export function computeBenchmarkVerdict(
  tabpfn: TabpfnResult,
  aggregates: Aggregates,
): BenchmarkVerdict | null {
  if (!tabpfn.benchmark) return null;
  const g = totalsGrid(aggregates.monthlyTotals);
  const n = g.months.length;
  if (n < 2) return null;
  const heldOutMonth = g.months[n - 1];

  const perCategory: CategoryBenchmark[] = [];
  for (const category of g.categories) {
    const prediction = tabpfn.benchmark[category];
    if (prediction === undefined) continue;
    const totals = g.grid.get(category)!;
    const actual = totals[n - 1];
    const naive = totals[n - 2];
    perCategory.push({
      category,
      tabpfnPrediction: round2(prediction),
      naivePrediction: naive,
      actual,
      tabpfnError: round2(Math.abs(prediction - actual)),
      naiveError: round2(Math.abs(naive - actual)),
    });
  }
  if (perCategory.length === 0) return null;
  perCategory.sort((a, b) => a.category.localeCompare(b.category));

  const mae = (pick: (r: CategoryBenchmark) => number): number =>
    round2(perCategory.reduce((s, r) => s + pick(r), 0) / perCategory.length);
  const tabpfnMae = mae((r) => r.tabpfnError);
  const naiveMae = mae((r) => r.naiveError);
  const winner =
    tabpfnMae < naiveMae ? "TabPFN" : naiveMae < tabpfnMae ? "naive" : "tie";
  return { heldOutMonth, perCategory, tabpfnMae, naiveMae, winner };
}

/**
 * FR-8: flag debits whose actual amount is an outlier against the
 * TabPFN expected amount (out-of-fold — see worker.py). Sorted by
 * ratio descending, capped at ANOMALY_CAP. Reason strings are built
 * from the actual numbers, a comparison — never a probability claim.
 */
export function flagAnomalies(
  debits: readonly DebitFeatures[],
  amounts: Readonly<Record<string, number>>,
): Anomaly[] {
  const flagged: Anomaly[] = [];
  for (const d of debits) {
    const expected = amounts[String(d.id)];
    if (expected === undefined || !Number.isFinite(expected)) continue;
    const gap = d.amount - expected;
    const ratio = expected > 0 ? d.amount / expected : Number.POSITIVE_INFINITY;
    if (!(d.amount > ANOMALY_RATIO * expected && gap > ANOMALY_MIN_GAP)) continue;
    flagged.push({
      id: d.id,
      date: d.date,
      description: d.description,
      category: d.category,
      amount: d.amount,
      expected,
      ratio,
      gap,
      reason:
        `${fmtINR(d.amount)} at ${d.merchantKey.toUpperCase()} — about ` +
        `${fmtRatio(ratio)}× the ~${fmtINR(Math.round(expected))} expected for ` +
        `${d.category} from its history`,
    });
  }
  flagged.sort((a, b) => b.ratio - a.ratio || b.amount - a.amount);
  return flagged.slice(0, ANOMALY_CAP);
}
