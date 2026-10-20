// Rows -> normalized Txn[] (DESIGN §4): DD/MM/YY + DD-MMM-YYYY dates,
// Indian amount formats (1,45,000.00, Cr/Dr suffixes), sign from the
// Withdrawal/Deposit columns, exclusion of non-transaction rows
// (opening/closing balance, totals, blanks). IDs are sequential in
// file order — deterministic, so runs are reproducible.

import { parseCsv } from "./csv.js";
import { mapColumns, type LayoutName } from "./columns.js";
import { ParseError, type Txn } from "../types.js";

export interface ParseResult {
  txns: Txn[];
  /** Rows dropped as non-transactions (balance lines, totals, blanks). */
  excluded: number;
  layout: LayoutName;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** "05/06/26" | "05/06/2026" | "05-Jun-2026" | "2026-06-05" -> ISO date, or null. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const month = Number(m[2]);
    const day = Number(m[1]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${pad(month)}-${pad(day)}`;
  }
  m = /^(\d{1,2})[- ]([A-Za-z]{3,})[- ](\d{2,4})$/.exec(s);
  if (m) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!month) return null;
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${year}-${pad(month)}-${pad(Number(m[1]))}`;
  }
  return null;
}

/**
 * "1,45,000.00" -> 145000 · "1,240.00 Cr" -> +1240 · "240.00 Dr" -> -240 ·
 * "(500.00)" -> -500 · "" / "-" -> null.
 */
export function parseAmount(raw: string): number | null {
  let s = raw.trim();
  if (s === "" || s === "-") return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1).trim();
  }
  const suffix = /\s*(cr|dr)\.?$/i.exec(s);
  if (suffix) {
    sign = suffix[1].toLowerCase() === "dr" ? -1 : 1;
    s = s.slice(0, suffix.index).trim();
  }
  s = s.replace(/,/g, "").replace(/^(rs\.?|inr|₹)\s*/i, "");
  const negative = s.startsWith("-");
  const digits = s.replace(/^[+-]/, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const magnitude = Number(digits);
  if (suffix || sign === -1) return sign * magnitude;
  return negative ? -magnitude : magnitude;
}

const NON_TXN_NARRATION = /^(opening balance|closing balance|total|statement summary)\b/i;

export function parseStatement(text: string): ParseResult {
  if (!text || text.trim() === "") {
    throw new ParseError("The statement file is empty — there is nothing to parse.");
  }
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new ParseError("The statement file is empty — there is nothing to parse.");
  }
  const map = mapColumns(rows[0]); // throws UnrecognizedColumns

  const txns: Txn[] = [];
  let excluded = 0;

  for (const row of rows.slice(1)) {
    if (row.every((c) => c.trim() === "")) {
      excluded++;
      continue;
    }
    const description = (row[map.description] ?? "").trim();

    let amount: number | null;
    if (map.amount !== undefined) {
      amount = parseAmount(row[map.amount] ?? "");
    } else {
      const withdrawal = parseAmount(row[map.withdrawal ?? 0] ?? "");
      const deposit = parseAmount(row[map.deposit ?? 0] ?? "");
      if (withdrawal === null && deposit === null) {
        excluded++; // balance line / totals row — no money moved
        continue;
      }
      amount = (deposit ?? 0) - (withdrawal ?? 0);
    }
    if (amount === null || NON_TXN_NARRATION.test(description)) {
      excluded++;
      continue;
    }

    const rawDate = row[map.date] ?? "";
    const date = parseDate(rawDate);
    if (date === null) {
      throw new ParseError(
        `Could not read the date "${rawDate.trim()}" on the row "${description}" — ` +
          `expected DD/MM/YY or DD-MMM-YYYY.`,
      );
    }
    const balance = map.balance !== undefined ? parseAmount(row[map.balance] ?? "") : null;
    txns.push({
      id: txns.length + 1,
      date,
      description,
      amount,
      ...(balance !== null ? { balance } : {}),
    });
  }

  if (txns.length === 0) {
    throw new ParseError(
      "No transactions found — every row was a header, a balance line, or blank. " +
        "Check that this is a statement transactions export.",
    );
  }
  return { txns, excluded, layout: map.layout };
}
