import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatement } from "../src/parse/normalize.js";
import { categorizeDeterministic } from "../src/categorize/categorize.js";
import { aggregate } from "../src/aggregate.js";
import {
  buildBenchmarkSamples,
  buildDebits,
  buildForecastSamples,
  preflightTabpfn,
  runTabpfn,
  type SpawnWorker,
  type WorkerRequest,
} from "../src/tabpfn/client.js";
import {
  TabpfnUnavailable,
  type Aggregates,
  type CategorizedTxn,
  type CategoryMonthTotal,
} from "../src/types.js";

const totals = (rows: [string, string, number][]): CategoryMonthTotal[] =>
  rows.map(([month, category, total]) => ({
    month,
    category: category as CategoryMonthTotal["category"],
    total,
    count: 1,
  }));

// Groceries steady ~12k/mo; Transport absent in July (no cell -> 0);
// Income present but never a spend forecast; "Other" never appears
// (zero history -> must never be predicted).
const THREE_MONTHS = totals([
  ["2026-06", "Groceries", 12000],
  ["2026-07", "Groceries", 12600],
  ["2026-08", "Groceries", 12100],
  ["2026-06", "Transport", 4000],
  ["2026-08", "Transport", 3900],
  ["2026-06", "Income", 150000],
  ["2026-07", "Income", 150000],
  ["2026-08", "Income", 150000],
]);

describe("sample builders (DESIGN §3 sliding construction)", () => {
  it("forecast: train targets months 1..N-1 with lag1/rollMean; test is month N", () => {
    const { train, test } = buildForecastSamples(THREE_MONTHS);
    const g = train.filter((s) => s.category === "Groceries");
    expect(g).toHaveLength(2);
    expect(g[0]).toEqual({
      category: "Groceries", monthIndex: 1, monthOfYear: 7,
      lag1: 12000, rollMean: 12000, target: 12600,
    });
    expect(g[1]).toEqual({
      category: "Groceries", monthIndex: 2, monthOfYear: 8,
      lag1: 12600, rollMean: 12300, target: 12100,
    });
    const gt = test.find((s) => s.category === "Groceries")!;
    expect(gt).toEqual({
      category: "Groceries", monthIndex: 3, monthOfYear: 9,
      lag1: 12100, rollMean: 12350, key: "Groceries",
    });
  });

  it("a month with no cell counts as 0 spend in the grid", () => {
    const { train } = buildForecastSamples(THREE_MONTHS);
    const aug = train.find((s) => s.category === "Transport" && s.monthIndex === 2)!;
    expect(aug.lag1).toBe(0); // July: no Transport cell
    expect(aug.target).toBe(3900);
  });

  it("Income is excluded and a zero-history category is never predicted", () => {
    const { train, test } = buildForecastSamples(THREE_MONTHS);
    expect(train.every((s) => s.category !== "Income")).toBe(true);
    expect(test.map((s) => s.category).sort()).toEqual(["Groceries", "Transport"]);
    expect(test.some((s) => s.category === "Other")).toBe(false);
  });

  it("benchmark: same builder, cutoff moved — train ≤ N-2, predict month N-1", () => {
    const { train, test } = buildBenchmarkSamples(THREE_MONTHS);
    expect(train.every((s) => (s.monthIndex ?? 0) <= 1)).toBe(true);
    const g = test.find((s) => s.category === "Groceries")!;
    // Predicting held-out Aug 2026 from data through July.
    expect(g.monthIndex).toBe(2);
    expect(g.lag1).toBe(12600);
    expect(g.rollMean).toBe(12300);
    expect(g.target).toBeUndefined();
  });

  it("forecast month-of-year rolls over the year boundary", () => {
    const two = totals([
      ["2026-11", "Groceries", 1000],
      ["2026-12", "Groceries", 1100],
    ]);
    const { test } = buildForecastSamples(two);
    expect(test[0].monthIndex).toBe(2);
    expect(test[0].monthOfYear).toBe(1);
  });
});

describe("buildDebits (DESIGN §2 debit shape)", () => {
  const txns: CategorizedTxn[] = [
    { id: 1, date: "2026-09-14", description: "POS-CROMA VASHI", amount: -32999, category: "Shopping", source: "rule" },
    { id: 2, date: "2026-09-01", description: "POS-CROMA VASHI", amount: -2400, category: "Shopping", source: "rule" },
    { id: 3, date: "2026-09-02", description: "SALARY", amount: 150000, category: "Income", source: "rule" },
  ];
  const aggs = aggregate(txns);

  it("keeps debits only, positive magnitudes, Monday 2026-09-14 -> weekday 1", () => {
    const debits = buildDebits(txns, aggs);
    expect(debits.map((d) => d.id)).toEqual([1, 2]);
    expect(debits[0].amount).toBe(32999);
    expect(debits[0].weekday).toBe(1);
    expect(debits[0].dayOfMonth).toBe(14);
    expect(debits[0].month).toBe("2026-09");
  });

  it("merchant median is leave-one-out; category median is the plain median", () => {
    const debits = buildDebits(txns, aggs);
    // Croma debits: 32999 (id 1), 2400 (id 2). LOO: each row sees
    // only the OTHER Croma debit. Category median keeps both: 17699.5.
    expect(debits[0].merchantKey).toBe("croma");
    expect(debits[0].merchantMedian).toBe(2400);
    expect(debits[1].merchantMedian).toBe(32999);
    expect(debits[0].categoryMedian).toBe(17699.5);
    expect(debits[1].categoryMedian).toBe(17699.5);
  });

  it("a single-occurrence merchant falls back to the category median (no self-leak)", () => {
    const single: CategorizedTxn[] = [
      { id: 1, date: "2026-09-10", description: "POS-CROMA VASHI", amount: -32999, category: "Shopping", source: "rule" },
      { id: 2, date: "2026-09-11", description: "AMAZON RETAIL", amount: -1500, category: "Shopping", source: "rule" },
      { id: 3, date: "2026-09-12", description: "MYNTRA DESIGNS", amount: -2500, category: "Shopping", source: "rule" },
    ];
    const debits = buildDebits(single, aggregate(single));
    // Shopping median over [32999, 1500, 2500] = 2500 — the CROMA row
    // must NOT see its own 32999 as its merchant median.
    expect(debits[0].merchantMedian).toBe(2500);
    expect(debits[0].merchantMedian).toBe(debits[0].categoryMedian);
  });
});

// ---------------------------------------------------------------------------
// Pre-flight + failure mapping, with an injected fake worker.
// ---------------------------------------------------------------------------

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ls-tabpfn-"));
  writeFileSync(join(dir, "python"), "# fake venv python (existence only)");
  writeFileSync(join(dir, "tabpfn-v3.5-20260909.safetensors"), "fake");
  writeFileSync(join(dir, "auth_token"), "fake");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const preflightOk = () => ({
  token: "test-token",
  venvPython: join(dir, "python"),
  workerPath: join(dir, "python"),
  cacheDir: dir,
});

const emptyAggs = (months: string[], monthlyTotals: CategoryMonthTotal[] = []): Aggregates => ({
  months,
  byCategory: [],
  monthlyTotals,
  deltas: [],
  topMerchants: [],
});

const okJson = (extra: object) => ({
  code: 0,
  stdout: JSON.stringify({ ok: true, meta: { tabpfn: "9.2.0", checkpoint: "tabpfn-v3.5-x.safetensors", fitSeconds: {} }, ...extra }),
  stderr: "",
});

describe("preflightTabpfn (DESIGN §2 order: token -> venv -> checkpoint)", () => {
  it("missing token and no cached auth -> TabpfnUnavailable naming TABPFN_TOKEN", () => {
    const bare = mkdtempSync(join(tmpdir(), "ls-tabpfn-bare-"));
    try {
      expect(() =>
        preflightTabpfn({ token: "", venvPython: join(dir, "python"), workerPath: "x", cacheDir: bare }),
      ).toThrowError(TabpfnUnavailable);
      expect(() =>
        preflightTabpfn({ token: "", venvPython: join(dir, "python"), workerPath: "x", cacheDir: bare }),
      ).toThrowError(/TABPFN_TOKEN/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("cached auth_token satisfies the token leg", () => {
    expect(() => preflightTabpfn({ ...preflightOk(), token: "" })).not.toThrow();
  });

  it("missing venv -> reason points at the venv", () => {
    expect(() =>
      preflightTabpfn({ ...preflightOk(), venvPython: join(dir, "nope") }),
    ).toThrowError(/venv not found/);
  });

  it("missing checkpoint -> reason names the checkpoint", () => {
    const noCkpt = mkdtempSync(join(tmpdir(), "ls-tabpfn-nockpt-"));
    writeFileSync(join(noCkpt, "auth_token"), "fake");
    try {
      expect(() => preflightTabpfn({ ...preflightOk(), cacheDir: noCkpt })).toThrowError(
        /checkpoint not found/,
      );
    } finally {
      rmSync(noCkpt, { recursive: true, force: true });
    }
  });
});

const ONE_DEBIT: CategorizedTxn[] = [
  { id: 1, date: "2026-08-03", description: "UPI-SWIGGY-BANGALORE", amount: -950, category: "Food & Dining", source: "rule" },
];

describe("runTabpfn with an injected fake worker", () => {
  it("maps a good round-trip; job selection is data-driven", async () => {
    let seen: WorkerRequest | null = null;
    const fake: SpawnWorker = async (req) => {
      seen = req;
      return okJson({ forecast: { Groceries: 13000 }, benchmark: { Groceries: 12500 }, amounts: { "1": 900 } });
    };
    const result = await runTabpfn(ONE_DEBIT, emptyAggs(["2026-06", "2026-07", "2026-08"], THREE_MONTHS), {
      ...preflightOk(),
      spawnWorker: fake,
    });
    expect(seen!.jobs).toEqual(["forecast", "benchmark", "amounts"]);
    expect(seen!.samples.forecast!.train.length).toBeGreaterThan(0);
    expect(seen!.debits).toHaveLength(1);
    expect(result.forecast).toEqual({ Groceries: 13000 });
    expect(result.benchmark).toEqual({ Groceries: 12500 });
    expect(result.amounts).toEqual({ "1": 900 });
    expect(result.forecastSkipped).toBe(false);
    expect(result.meta?.tabpfn).toBe("9.2.0");
  });

  it("two months: forecast runs, benchmark is not requested", async () => {
    let seen: WorkerRequest | null = null;
    const fake: SpawnWorker = async (req) => {
      seen = req;
      return okJson({ forecast: { Groceries: 13000 }, amounts: { "1": 900 } });
    };
    const two = totals([
      ["2026-06", "Groceries", 12000],
      ["2026-07", "Groceries", 12600],
    ]);
    const result = await runTabpfn(ONE_DEBIT, emptyAggs(["2026-06", "2026-07"], two), {
      ...preflightOk(),
      spawnWorker: fake,
    });
    expect(seen!.jobs).toEqual(["forecast", "amounts"]);
    expect(result.benchmark).toBeNull();
  });

  it("single month: forecast-skipped marker, amounts still served", async () => {
    const debit: CategorizedTxn[] = [
      { id: 7, date: "2026-06-05", description: "UPI-SWIGGY-BANGALORE", amount: -500, category: "Food & Dining", source: "rule" },
    ];
    let seen: WorkerRequest | null = null;
    const fake: SpawnWorker = async (req) => {
      seen = req;
      return okJson({ amounts: { "7": 480 } });
    };
    const one = totals([["2026-06", "Food & Dining", 500]]);
    const result = await runTabpfn(debit, emptyAggs(["2026-06"], one), {
      ...preflightOk(),
      spawnWorker: fake,
    });
    expect(seen!.jobs).toEqual(["amounts"]);
    expect(result.forecastSkipped).toBe(true);
    expect(result.forecast).toBeNull();
    expect(result.amounts).toEqual({ "7": 480 });
  });

  it("non-zero exit -> TabpfnUnavailable with the stderr tail", async () => {
    const fake: SpawnWorker = async () => ({ code: 1, stdout: "", stderr: "line one\nthe real reason" });
    await expect(
      runTabpfn([], emptyAggs(["2026-06", "2026-07"], THREE_MONTHS.slice(0, 4)), { ...preflightOk(), spawnWorker: fake }),
    ).rejects.toThrowError(/the real reason/);
  });

  it("garbage stdout -> TabpfnUnavailable (invalid JSON)", async () => {
    const fake: SpawnWorker = async () => ({ code: 0, stdout: "not json{", stderr: "" });
    await expect(
      runTabpfn([], emptyAggs(["2026-06", "2026-07"], THREE_MONTHS.slice(0, 4)), { ...preflightOk(), spawnWorker: fake }),
    ).rejects.toThrowError(/invalid JSON/);
  });

  it("worker ok:false -> TabpfnUnavailable carrying its error", async () => {
    const fake: SpawnWorker = async () => ({
      code: 0,
      stdout: JSON.stringify({ ok: false, error: "license rejected" }),
      stderr: "",
    });
    await expect(
      runTabpfn([], emptyAggs(["2026-06", "2026-07"], THREE_MONTHS.slice(0, 4)), { ...preflightOk(), spawnWorker: fake }),
    ).rejects.toThrowError(/license rejected/);
  });

  it("a hung worker hits the client timeout -> TabpfnUnavailable", async () => {
    const fake: SpawnWorker = () => new Promise(() => {});
    await expect(
      runTabpfn([], emptyAggs(["2026-06", "2026-07"], THREE_MONTHS.slice(0, 4)), {
        ...preflightOk(),
        spawnWorker: fake,
        timeoutMs: 50,
      }),
    ).rejects.toThrowError(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// Real-worker round-trips on the S3 fixture (slow: real TabPFN fits).
// ---------------------------------------------------------------------------

const { txns } = parseStatement(readFileSync("fixtures/statement.csv", "utf8"));
const { categorized } = categorizeDeterministic(txns, []);
const fixtureAggs = aggregate(categorized);

describe("buildDebits on the fixture (LOO merchant median)", () => {
  it("planted CROMA row (id 220) does not leak its own amount into merchantMedian", () => {
    const debits = buildDebits(categorized, fixtureAggs);
    const croma = debits.find((d) => d.id === 220)!;
    const shoppingMedian = fixtureAggs.byCategory.find(
      (c) => c.category === "Shopping",
    )!.medianDebit;
    // CROMA occurs exactly once in the fixture, so the LOO median is
    // the Shopping category median — clean, and far below ₹32,999.
    expect(croma.merchantMedian).toBe(shoppingMedian);
    expect(croma.merchantMedian).toBeLessThan(32999 / 2.5);
  });
});
const SPEND_CATEGORIES = [
  ...new Set(fixtureAggs.monthlyTotals.filter((t) => t.category !== "Income").map((t) => t.category)),
].sort();

// Real-TabPFN round-trip needs the local Python worker venv (python/.venv);
// it runs where that venv exists and skips cleanly in fresh clones / CI.
const tabpfnVenvPresent = existsSync(join(process.cwd(), "python", ".venv", "bin", "python"));
describe.skipIf(!tabpfnVenvPresent)("worker round-trip on the fixture (real TabPFN)", () => {
  it(
    "forecasts every spend category with history; zero-history absent; amounts cover all debits",
    { timeout: 900_000 },
    async () => {
      const result = await runTabpfn(categorized, fixtureAggs);
      expect(result.forecastSkipped).toBe(false);
      expect(result.forecast).not.toBeNull();
      expect(Object.keys(result.forecast!).sort()).toEqual(SPEND_CATEGORIES);
      expect(result.forecast!["Other"]).toBeUndefined(); // zero history: never a fabricated ₹0
      expect(result.forecast!["Income"]).toBeUndefined();
      for (const v of Object.values(result.forecast!)) {
        expect(Number.isFinite(v)).toBe(true);
      }
      // The two big steady categories must get real, positive forecasts.
      expect(result.forecast!["Groceries"]).toBeGreaterThan(0);
      expect(result.forecast!["Food & Dining"]).toBeGreaterThan(0);
      expect(Object.keys(result.benchmark!).sort()).toEqual(SPEND_CATEGORIES);
      const debitCount = categorized.filter((t) => t.amount < 0).length;
      expect(Object.keys(result.amounts)).toHaveLength(debitCount);
      const cromaExpected = result.amounts["220"]; // planted anomaly row
      expect(cromaExpected).toBeGreaterThan(0);
      expect(cromaExpected).toBeLessThan(32999);
      // S10 acceptance: with the LOO merchant median the DESIGN §3
      // flag rule (ratio > 2.5x AND gap > ₹1,000) can actually fire
      // on the planted anomaly — it could not while the feature
      // leaked the row's own amount.
      expect(32999).toBeGreaterThan(2.5 * cromaExpected);
      expect(32999 - cromaExpected).toBeGreaterThan(1000);
      expect(result.meta?.tabpfn).toBe("9.2.0");
      expect(result.meta?.checkpoint).toMatch(/^tabpfn-v3\.5-/);
      expect(Object.keys(result.meta!.fitSeconds).sort()).toEqual(["amounts", "benchmark", "forecast"]);
    },
  );

  it(
    "single-month fixture slice: forecast skipped, amounts still served",
    { timeout: 900_000 },
    async () => {
      const june = categorized.filter((t) => t.date.startsWith("2026-06"));
      const result = await runTabpfn(june, aggregate(june));
      expect(result.forecastSkipped).toBe(true);
      expect(result.forecast).toBeNull();
      expect(result.benchmark).toBeNull();
      expect(Object.keys(result.amounts).length).toBeGreaterThan(0);
    },
  );
});
