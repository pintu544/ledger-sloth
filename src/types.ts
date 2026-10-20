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

/** Per-category roll-up over a set of categorized transactions. */
export interface CategoryStats {
  category: Category;
  count: number;
  /** Sum of positive amounts (money in). */
  credits: number;
  /** Sum of debit magnitudes (money out), as a positive number. */
  debits: number;
  /** credits - debits (== the signed sum). */
  net: number;
  /** Median of debit amounts (positive magnitudes); 0 when no debits. */
  medianDebit: number;
  /** Median absolute deviation of debit amounts; 0 when no debits. */
  madDebit: number;
}

/** One (month, category) cell of spend — the worker's monthlyTotals shape (DESIGN §2). */
export interface CategoryMonthTotal {
  month: string;
  category: Category;
  /** Debit spend (positive magnitudes). */
  total: number;
  count: number;
}

export interface MonthDelta {
  category: Category;
  month: string;
  prevMonth: string;
  /** Spend change vs the previous month (signed). */
  delta: number;
  /** delta / previous spend; null when the previous month had no spend. */
  pct: number | null;
}

export interface MerchantTotal {
  merchantKey: string;
  count: number;
  /** Total debit spend (positive magnitudes). */
  debits: number;
}

export interface Aggregates {
  /** Sorted statement months present in the input, YYYY-MM. */
  months: string[];
  byCategory: CategoryStats[];
  monthlyTotals: CategoryMonthTotal[];
  deltas: MonthDelta[];
  topMerchants: MerchantTotal[];
}

/** One flagged anomalous debit (SPEC FR-8), judged in TS (DESIGN §3). */
export interface Anomaly {
  id: number;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  description: string;
  category: Category;
  /** Actual debit amount (positive magnitude). */
  amount: number;
  /** TabPFN expected amount for this debit (out-of-fold prediction). */
  expected: number;
  /** amount / expected. */
  ratio: number;
  /** amount - expected. */
  gap: number;
  /** One-line reason built from the actual numbers (DESIGN §3). */
  reason: string;
}

/** One category's row of the FR-9 benchmark on the held-out month. */
export interface CategoryBenchmark {
  category: Category;
  tabpfnPrediction: number;
  /** Naive baseline: the previous month's total, carried forward. */
  naivePrediction: number;
  actual: number;
  tabpfnError: number;
  naiveError: number;
}

/** The FR-9 verdict: TabPFN vs naive on the held-out last month. */
export interface BenchmarkVerdict {
  heldOutMonth: string;
  perCategory: CategoryBenchmark[];
  tabpfnMae: number;
  naiveMae: number;
  winner: "TabPFN" | "naive" | "tie";
}

/**
 * The TabPFN stage's outcome, judged in TS (DESIGN §2/§6): either
 * forecasts (+ the FR-9 verdict) or an explicit degradation — the
 * report renders every branch; none is ever silently dropped.
 * Anomalies travel with the outcome: they exist whenever the
 * amounts job ran, including the single-month case.
 */
export type ForecastOutcome =
  | {
      kind: "ok";
      forecast: Record<string, number>;
      verdict: BenchmarkVerdict | null;
      anomalies: Anomaly[];
    }
  | { kind: "insufficient-history"; anomalies: Anomaly[] }
  | { kind: "unavailable"; reason: string };

/** The FR-11 run-metrics block, assembled by the CLI (DESIGN §7). */
export interface RunMetrics {
  rowsParsed: number;
  rowsExcluded: number;
  stageSeconds: {
    parse: number;
    rulesMemory: number;
    gemmaCategorize: number;
    aggregate: number;
    tabpfn: number;
    narrative: number;
    render: number;
    total: number;
  };
  gemmaRequests: number;
  sourceCounts: { memory: number; rule: number; gemma: number; other: number };
  gemmaModel: string;
  ollamaVersion: string | null;
  tabpfnVersion: string | null;
  tabpfnFitSeconds: Record<string, number> | null;
  checkpoint: string | null;
  checkpointMb: number | null;
  pythonEnvMb: number | null;
  hostLine: string;
  narrativeSource: "gemma" | "template";
  narrativeAttempts: number;
  narrativeInventedFigures: number[];
  /** Set only on --ground-truth runs. */
  accuracyPct: number | null;
  verdict: BenchmarkVerdict | null;
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
