// Aggregates (DESIGN §1 stage [4], SPEC FR-5): pure functions over
// categorized transactions — per-category totals/counts, monthly
// spend cells (the TabPFN worker's input shape), month-over-month
// deltas, top merchants, and per-category median/MAD of debit amounts
// (the robust center/spread the anomaly stage reasons about).

import { merchantKey } from "./categorize/memory.js";
import type {
  Aggregates,
  CategorizedTxn,
  Category,
  CategoryMonthTotal,
  CategoryStats,
  MerchantTotal,
  MonthDelta,
} from "./types.js";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mad(values: readonly number[], center: number): number {
  if (values.length === 0) return 0;
  return median(values.map((v) => Math.abs(v - center)));
}

const monthOf = (date: string): string => date.slice(0, 7);

export function aggregate(txns: readonly CategorizedTxn[]): Aggregates {
  const months = [...new Set(txns.map((t) => monthOf(t.date)))].sort();

  const byCat = new Map<Category, CategorizedTxn[]>();
  for (const t of txns) {
    const list = byCat.get(t.category) ?? [];
    list.push(t);
    byCat.set(t.category, list);
  }

  const byCategory: CategoryStats[] = [...byCat.entries()]
    .map(([category, list]) => {
      const debitAmounts = list.filter((t) => t.amount < 0).map((t) => -t.amount);
      const credits = round2(list.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0));
      const debits = round2(debitAmounts.reduce((s, v) => s + v, 0));
      const med = median(debitAmounts);
      return {
        category,
        count: list.length,
        credits,
        debits,
        net: round2(credits - debits),
        medianDebit: round2(med),
        madDebit: round2(mad(debitAmounts, med)),
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category));

  const monthlyTotals: CategoryMonthTotal[] = [];
  const spend = new Map<string, number>(); // "month|category" -> debit spend
  for (const month of months) {
    for (const category of byCat.keys()) {
      const list = txns.filter((t) => monthOf(t.date) === month && t.category === category);
      if (list.length === 0) continue;
      const total = round2(
        list.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0),
      );
      monthlyTotals.push({ month, category, total, count: list.length });
      spend.set(`${month}|${category}`, total);
    }
  }
  monthlyTotals.sort(
    (a, b) => a.month.localeCompare(b.month) || a.category.localeCompare(b.category),
  );

  const deltas: MonthDelta[] = [];
  for (let i = 1; i < months.length; i++) {
    const month = months[i];
    const prevMonth = months[i - 1];
    for (const category of [...byCat.keys()].sort()) {
      const cur = spend.get(`${month}|${category}`) ?? 0;
      const prev = spend.get(`${prevMonth}|${category}`) ?? 0;
      deltas.push({
        category,
        month,
        prevMonth,
        delta: round2(cur - prev),
        pct: prev > 0 ? Math.round(((cur - prev) / prev) * 10000) / 10000 : null,
      });
    }
  }

  const byMerchant = new Map<string, { count: number; debits: number }>();
  for (const t of txns) {
    if (t.amount >= 0) continue;
    const key = merchantKey(t.description);
    const entry = byMerchant.get(key) ?? { count: 0, debits: 0 };
    entry.count++;
    entry.debits = round2(entry.debits - t.amount);
    byMerchant.set(key, entry);
  }
  const topMerchants: MerchantTotal[] = [...byMerchant.entries()]
    .map(([key, v]) => ({ merchantKey: key, count: v.count, debits: v.debits }))
    .sort((a, b) => b.debits - a.debits || a.merchantKey.localeCompare(b.merchantKey))
    .slice(0, 10);

  return { months, byCategory, monthlyTotals, deltas, topMerchants };
}
