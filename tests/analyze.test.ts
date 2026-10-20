import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStatement } from "../src/parse/normalize.js";
import { categorizeDeterministic } from "../src/categorize/categorize.js";
import { aggregate } from "../src/aggregate.js";
import { buildDebits, type DebitFeatures, type TabpfnResult } from "../src/tabpfn/client.js";
import { computeBenchmarkVerdict, flagAnomalies } from "../src/tabpfn/analyze.js";
import type { Aggregates, CategoryMonthTotal } from "../src/types.js";

const totals = (rows: [string, string, number][]): CategoryMonthTotal[] =>
  rows.map(([month, category, total]) => ({
    month,
    category: category as CategoryMonthTotal["category"],
    total,
    count: 1,
  }));

const aggsOf = (monthlyTotals: CategoryMonthTotal[]): Aggregates => ({
  months: [...new Set(monthlyTotals.map((t) => t.month))].sort(),
  byCategory: [],
  monthlyTotals,
  deltas: [],
  topMerchants: [],
});

const resultOf = (benchmark: Record<string, number> | null): TabpfnResult => ({
  forecast: null,
  benchmark,
  amounts: {},
  forecastSkipped: false,
  meta: null,
});

// Jun–Sep; held-out = Sep 2026.
const FOUR_MONTHS = totals([
  ["2026-06", "Groceries", 12000],
  ["2026-07", "Groceries", 12600],
  ["2026-08", "Groceries", 12100],
  ["2026-09", "Groceries", 12400],
  ["2026-06", "Transport", 4000],
  ["2026-07", "Transport", 4100],
  ["2026-08", "Transport", 3900],
  ["2026-09", "Transport", 4050],
]);

describe("computeBenchmarkVerdict (FR-9)", () => {
  it("scores TabPFN vs naive (previous month) on the held-out month, per category + MAE", () => {
    const v = computeBenchmarkVerdict(
      resultOf({ Groceries: 12300, Transport: 4000 }),
      aggsOf(FOUR_MONTHS),
    )!;
    expect(v.heldOutMonth).toBe("2026-09");
    const g = v.perCategory.find((r) => r.category === "Groceries")!;
    expect(g).toEqual({
      category: "Groceries",
      tabpfnPrediction: 12300,
      naivePrediction: 12100, // Aug total carried forward
      actual: 12400,
      tabpfnError: 100,
      naiveError: 300,
    });
    const t = v.perCategory.find((r) => r.category === "Transport")!;
    expect(t.tabpfnError).toBe(50);
    expect(t.naiveError).toBe(150);
    expect(v.tabpfnMae).toBe(75);
    expect(v.naiveMae).toBe(225);
    expect(v.winner).toBe("TabPFN");
  });

  it("names the naive baseline the winner when it is — no framing (SPEC FR-9)", () => {
    const v = computeBenchmarkVerdict(
      resultOf({ Groceries: 20000, Transport: 9000 }),
      aggsOf(FOUR_MONTHS),
    )!;
    expect(v.winner).toBe("naive");
    expect(v.tabpfnMae).toBeGreaterThan(v.naiveMae);
  });

  it("reports a tie when the MAEs are equal", () => {
    const v = computeBenchmarkVerdict(
      resultOf({ Groceries: 12700, Transport: 4200 }), // errors 300 + 150, like naive
      aggsOf(FOUR_MONTHS),
    )!;
    expect(v.tabpfnMae).toBe(v.naiveMae);
    expect(v.winner).toBe("tie");
  });

  it("is null when there are no benchmark predictions (too little history)", () => {
    expect(computeBenchmarkVerdict(resultOf(null), aggsOf(FOUR_MONTHS))).toBeNull();
    expect(computeBenchmarkVerdict(resultOf({}), aggsOf(FOUR_MONTHS))).toBeNull();
  });

  it("Income never enters the verdict even when present in totals", () => {
    const withIncome = totals([
      ...FOUR_MONTHS.map((r) => [r.month, r.category, r.total] as [string, string, number]),
      ["2026-06", "Income", 145000],
      ["2026-07", "Income", 145000],
      ["2026-08", "Income", 145000],
      ["2026-09", "Income", 145000],
    ]);
    const v = computeBenchmarkVerdict(
      resultOf({ Groceries: 12300, Transport: 4000, Income: 145000 }),
      aggsOf(withIncome),
    )!;
    expect(v.perCategory.map((r) => r.category)).toEqual(["Groceries", "Transport"]);
  });
});

// ---------------------------------------------------------------------------

const debit = (id: number, amount: number, over: Partial<DebitFeatures> = {}): DebitFeatures => ({
  id,
  month: "2026-09",
  date: "2026-09-14",
  description: "POS-CROMA VASHI",
  category: "Shopping",
  amount,
  dayOfMonth: 14,
  weekday: 1,
  merchantKey: "croma",
  categoryMedian: 1774,
  merchantMedian: 1774,
  ...over,
});

describe("flagAnomalies (FR-8, DESIGN §3 thresholds)", () => {
  it("flags the planted-anomaly shape: ratio > 2.5x AND gap > ₹1,000, reason from the numbers", () => {
    const flags = flagAnomalies([debit(220, 32999)], { "220": 1938.5 });
    expect(flags).toHaveLength(1);
    expect(flags[0].id).toBe(220);
    expect(flags[0].reason).toContain("₹32,999");
    expect(flags[0].reason).toContain("CROMA");
    expect(flags[0].reason).toContain("17×");
    expect(flags[0].reason).toContain("Shopping");
  });

  it("the S9 leaked expectation (₹21,834) would NOT flag — ratio fails (regression)", () => {
    expect(flagAnomalies([debit(220, 32999)], { "220": 21834 })).toHaveLength(0);
  });

  it("ratio alone does not flag a small charge (gap below ₹1,000)", () => {
    // 1200 vs expected 400: ratio 3.0, gap 800.
    expect(flagAnomalies([debit(1, 1200)], { "1": 400 })).toHaveLength(0);
  });

  it("rows without a prediction are skipped, never guessed", () => {
    expect(flagAnomalies([debit(1, 99999)], {})).toHaveLength(0);
  });

  it("sorts by ratio descending and caps at 10", () => {
    const debits = Array.from({ length: 12 }, (_, i) =>
      debit(i + 1, 10000 + i * 1000, { merchantKey: `m${i}` }),
    );
    const amounts = Object.fromEntries(debits.map((d) => [String(d.id), 1000]));
    const flags = flagAnomalies(debits, amounts);
    expect(flags).toHaveLength(10);
    const ratios = flags.map((f) => f.ratio);
    expect(ratios).toEqual([...ratios].sort((a, b) => b - a));
    expect(flags[0].amount).toBe(21000); // largest ratio kept, smallest dropped
  });
});

describe("flagAnomalies on the fixture (integration, stubbed expectations)", () => {
  it("exactly the planted CROMA charge flags when expectations are history-typical", () => {
    const { txns } = parseStatement(readFileSync("fixtures/statement.csv", "utf8"));
    const { categorized } = categorizeDeterministic(txns, []);
    const debits = buildDebits(categorized, aggregate(categorized));
    // Every debit expects its own amount (ratio 1, no flag) except the
    // planted anomaly, which expects its measured out-of-fold value.
    const amounts = Object.fromEntries(debits.map((d) => [String(d.id), d.amount]));
    amounts["220"] = 1938.5;
    const flags = flagAnomalies(debits, amounts);
    expect(flags.map((f) => f.id)).toEqual([220]);
    expect(flags[0].reason).toContain("₹32,999");
  });
});
