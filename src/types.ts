// Shared types and typed errors for Ledger Sloth (DESIGN §4).

export interface Txn {
  /** Sequential id in file order, 1-based, transactions only. */
  id: number;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  description: string;
  /** Signed INR: credits positive, debits negative. */
  amount: number;
  balance?: number;
}

/** The fixed category list — single source of truth is categorize/categories.ts. */
export type Category =
  | "Income"
  | "Rent & Housing"
  | "Groceries"
  | "Food & Dining"
  | "Transport"
  | "Utilities & Bills"
  | "Subscriptions"
  | "Shopping"
  | "Health & Pharmacy"
  | "Entertainment"
  | "Investments"
  | "Transfers"
  | "Fees & Charges"
  | "Other";

export interface CategorizedTxn extends Txn {
  category: Category;
  source: "memory" | "rule" | "gemma" | "other";
}

/** Fatal, user-facing parse failure — plain message, no artifacts (SPEC). */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/** No plausible column mapping — lists the headers found (SPEC). */
export class UnrecognizedColumns extends Error {
  readonly headers: string[];
  constructor(headers: string[]) {
    super(
      `Could not recognize this statement's columns. Headers found: ${headers.join(", ")}. ` +
        `Ledger Sloth can read HDFC, ICICI, and SBI statement layouts, or any CSV with ` +
        `date, description, and debit/credit (or one signed amount) columns.`,
    );
    this.name = "UnrecognizedColumns";
    this.headers = headers;
  }
}

/** Ollama unreachable or model not pulled — message carries the fix commands. */
export class OllamaUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaUnavailable";
  }
}

/** TabPFN cannot run — the report degrades with this reason, never silently. */
export class TabpfnUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TabpfnUnavailable";
  }
}
