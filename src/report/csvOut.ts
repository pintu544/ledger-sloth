// Categorized CSV writer (SPEC FR-10): every input transaction, in
// input order, with its assigned category and how it got it. Fixed
// column order and fixed number formatting make the output
// byte-identical across runs over the same inputs (SPEC NFR).

import type { CategorizedTxn } from "../types.js";

export const CSV_COLUMNS = ["id", "date", "description", "amount", "category", "source"] as const;

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function renderCategorizedCsv(txns: readonly CategorizedTxn[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const t of txns) {
    lines.push(
      [
        String(t.id),
        t.date,
        csvField(t.description),
        t.amount.toFixed(2),
        csvField(t.category),
        t.source,
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
