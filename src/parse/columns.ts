// Header mapping (DESIGN §4). PRIMARY: HDFC layout; VARIANTS: ICICI
// and SBI; plus the generic signed-amount shape. Returns the mapping
// or throws UnrecognizedColumns listing the headers found — never a
// silent guess (SPEC failure mode).

import { UnrecognizedColumns } from "../types.js";

export type LayoutName = "hdfc" | "icici" | "sbi" | "signed";

export interface ColumnMap {
  layout: LayoutName;
  date: number;
  description: number;
  withdrawal?: number;
  deposit?: number;
  /** Single signed-amount column (generic shape) — mutually exclusive with withdrawal/deposit. */
  amount?: number;
  balance?: number;
}

/** "Withdrawal Amount (INR )" -> "withdrawal amount inr" */
function norm(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function find(headers: string[], candidates: string[]): number | undefined {
  for (const candidate of candidates) {
    const idx = headers.indexOf(candidate);
    if (idx !== -1) return idx;
  }
  return undefined;
}

export function mapColumns(rawHeaders: string[]): ColumnMap {
  const headers = rawHeaders.map(norm);

  // Preference order matters: HDFC carries both "Date" and "Value Dt",
  // ICICI both "Value Date" and "Transaction Date" — the transaction
  // date wins; a value date is only a fallback.
  const date = find(headers, ["date", "transaction date", "txn date", "trans date", "value date", "value dt"]);
  const description = find(headers, [
    "narration",
    "transaction remarks",
    "description",
    "remarks",
    "particulars",
    "details",
  ]);
  const withdrawal = find(headers, ["withdrawal amt", "withdrawal amount", "withdrawal amount inr", "withdrawal", "debit", "debit amount"]);
  const deposit = find(headers, ["deposit amt", "deposit amount", "deposit amount inr", "deposit", "credit", "credit amount"]);
  const balance = headers.findIndex((h) => h.includes("balance"));
  const amount = find(headers, ["amount", "transaction amount", "amt", "amount inr"]);

  if (date === undefined || description === undefined) {
    throw new UnrecognizedColumns(rawHeaders);
  }

  if (withdrawal !== undefined && deposit !== undefined) {
    let layout: LayoutName = "hdfc";
    if (headers[description] !== "narration") {
      if ((headers[withdrawal] ?? "").startsWith("withdrawal")) layout = "icici";
      else if (headers[withdrawal] === "debit") layout = "sbi";
    }
    return {
      layout,
      date,
      description,
      withdrawal,
      deposit,
      ...(balance !== -1 ? { balance } : {}),
    };
  }

  if (amount !== undefined) {
    return {
      layout: "signed",
      date,
      description,
      amount,
      ...(balance !== -1 ? { balance } : {}),
    };
  }

  throw new UnrecognizedColumns(rawHeaders);
}
