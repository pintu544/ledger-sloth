import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { aggregate } from "../src/aggregate.js";
import { renderReport, type ReportData } from "../src/report/render.js";
import { renderHtml } from "../src/report/html.js";
import { runReport } from "../src/index.js";
import type { SpawnWorker, WorkerRequest } from "../src/tabpfn/client.js";
import type {
  Anomaly,
  BenchmarkVerdict,
  CategorizedTxn,
  ForecastOutcome,
  RunMetrics,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// renderReport unit tests (hand-built data — no models involved)
// ---------------------------------------------------------------------------

const txns: CategorizedTxn[] = [
  { id: 1, date: "2026-06-01", description: "NEFT-ACME-SALARY", amount: 145000, category: "Income", source: "rule" },
  { id: 2, date: "2026-06-05", description: "UPI-SWIGGY", amount: -12000, category: "Food & Dining", source: "rule" },
  { id: 3, date: "2026-07-01", description: "NEFT-ACME-SALARY", amount: 145000, category: "Income", source: "rule" },
  { id: 4, date: "2026-07-05", description: "UPI-SWIGGY", amount: -12600, category: "Food & Dining", source: "rule" },
  { id: 5, date: "2026-08-01", description: "NEFT-ACME-SALARY", amount: 145000, category: "Income", source: "rule" },
  { id: 6, date: "2026-08-05", description: "UPI-SWIGGY", amount: -12100, category: "Food & Dining", source: "rule" },
  { id: 7, date: "2026-08-14", description: "POS-CROMA VASHI", amount: -32999, category: "Shopping", source: "rule" },
];
const aggs = aggregate(txns);

const anomaly: Anomaly = {
  id: 7, date: "2026-08-14", description: "POS-CROMA VASHI", category: "Shopping",
  amount: 32999, expected: 1938.5, ratio: 17.02, gap: 31060.5,
  reason: "₹32,999 at CROMA — about 17× the ~₹1,939 expected for Shopping from its history",
};

const verdict: BenchmarkVerdict = {
  heldOutMonth: "2026-08",
  perCategory: [
    { category: "Food & Dining", tabpfnPrediction: 12300, naivePrediction: 12600, actual: 12100, tabpfnError: 200, naiveError: 500 },
    { category: "Shopping", tabpfnPrediction: 5795, naivePrediction: 0, actual: 32999, tabpfnError: 27204, naiveError: 32999 },
  ],
  tabpfnMae: 13702,
  naiveMae: 16749.5,
  winner: "TabPFN",
};

const metrics = (over: Partial<RunMetrics> = {}): RunMetrics => ({
  rowsParsed: 7,
  rowsExcluded: 1,
  stageSeconds: { parse: 0.01, rulesMemory: 0.01, gemmaCategorize: 0, aggregate: 0.01, tabpfn: 54, narrative: 58, render: 0.01, total: 112 },
  gemmaRequests: 1,
  sourceCounts: { memory: 0, rule: 7, gemma: 0, other: 0 },
  gemmaModel: "gemma3:4b",
  ollamaVersion: "0.40.6",
  tabpfnVersion: "9.2.0",
  tabpfnFitSeconds: { forecast: 10.8, benchmark: 1.9, amounts: 40.1 },
  checkpoint: "tabpfn-v3.5-20260909.safetensors",
  checkpointMb: 876.5,
  pythonEnvMb: 1430.2,
  hostLine: "2 vCPU · 7.9 GB RAM · CPU-only",
  narrativeSource: "gemma",
  narrativeAttempts: 1,
  narrativeInventedFigures: [],
  accuracyPct: null,
  verdict,
  ...over,
});

const data = (outcome: ForecastOutcome, m?: RunMetrics): ReportData => ({
  statementName: "statement.csv",
  narrative: { text: "August was steady.", source: "gemma", attempts: 1, inventedFigures: [], requests: 1 },
  aggregates: aggs,
  latestMonthIncome: 145000,
  outcome,
  metrics: m ?? metrics(),
});

describe("renderReport", () => {
  it("contains every SPEC section on the full path", () => {
    const md = renderReport(
      data({ kind: "ok", forecast: { "Food & Dining": 13150, Shopping: 82866 }, verdict, anomalies: [anomaly] }),
    );
    for (const section of [
      "# Ledger Sloth — statement review",
      "## Month in review — Aug 2026",
      "## Spending by category",
      "## Forecast — next month (Sep 2026)",
      "## Forecast check — held-out Aug 2026 (FR-9)",
      "## Anomalies",
      "## Run metrics",
    ]) {
      expect(md).toContain(section);
    }
    expect(md).toContain("₹32,999"); // anomaly figure
    expect(md).toContain("₹82,866"); // forecast, raw
    expect(md).toContain("TabPFN won"); // verdict stated
    expect(md).toContain("No history — no forecast"); // zero-history categories named
    expect(md).toContain("tabpfn-v3.5-20260909.safetensors"); // metrics: checkpoint
    expect(md).toContain("2 vCPU"); // metrics: measured host line
  });

  it("states a naive win just as plainly (FR-9 honesty)", () => {
    const naiveVerdict: BenchmarkVerdict = { ...verdict, winner: "naive", tabpfnMae: 20000, naiveMae: 100 };
    const md = renderReport(
      data(
        { kind: "ok", forecast: { Shopping: 100 }, verdict: naiveVerdict, anomalies: [] },
        metrics({ verdict: naiveVerdict }),
      ),
    );
    expect(md).toContain("the naive baseline won");
    expect(md).toContain("No charges crossed the flag thresholds");
  });

  it("TabPFN unavailable: forecast + anomaly sections become explicit notes, no invented numbers", () => {
    const md = renderReport(
      data(
        { kind: "unavailable", reason: "TABPFN_TOKEN is not set" },
        metrics({ tabpfnVersion: null, tabpfnFitSeconds: null, verdict: null }),
      ),
    );
    expect(md).toContain("Forecast unavailable because TABPFN_TOKEN is not set");
    expect(md).toContain("Anomaly detection unavailable because TABPFN_TOKEN is not set");
    expect(md).not.toContain("## Forecast check");
    expect(md).not.toContain("| Category | Forecast |");
  });

  it("single month: insufficient-history note, anomalies still listed", () => {
    const oneMonth = aggregate(txns.filter((t) => t.date.startsWith("2026-08")));
    const md = renderReport({
      ...data({ kind: "insufficient-history", anomalies: [anomaly] }, metrics({ verdict: null })),
      aggregates: oneMonth,
    });
    expect(md).toContain("at least two months");
    expect(md).toContain("₹32,999 at CROMA");
    expect(md).not.toContain("## Forecast check");
  });
});

describe("renderHtml (SPEC FR-10)", () => {
  const md = renderReport(
    data({ kind: "ok", forecast: { Shopping: 82866 }, verdict, anomalies: [anomaly] }),
  );
  const html = renderHtml(md);

  it("is fully self-contained: zero external references", () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link|<script|<img|\ssrc=|\shref=|url\(|@import/);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
  });

  it("carries the sections and tables across", () => {
    expect(html).toContain("<h1>Ledger Sloth — statement review</h1>");
    expect(html).toContain("<h2>Anomalies</h2>");
    expect(html).toContain("<table>");
    expect(html).toContain("₹32,999");
    expect(html).toContain("<strong>Verdict: TabPFN won</strong>");
  });

  it("escapes HTML in narrative/description text", () => {
    const evil = renderHtml("# T\n\n<script>alert(1)</script> & \"quotes\"");
    expect(evil).not.toContain("<script>alert");
    expect(evil).toContain("&lt;script&gt;");
    expect(evil).toContain("&amp;");
  });
});

// ---------------------------------------------------------------------------
// runReport end-to-end with stubbed Ollama + stubbed worker spawn
// ---------------------------------------------------------------------------

const CSV = [
  "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
  '01/06/26,Opening Balance,,01/06/26,,,"1,00,000.00"',
  '01/06/26,NEFT-ACME PVT LTD-SALARY,,01/06/26,,"1,45,000.00","2,45,000.00"',
  '05/06/26,UPI-SWIGGY-BANGALORE,,05/06/26,850.00,,"2,44,150.00"',
  '06/06/26,POS-CROMA VASHI,,06/06/26,"1,749.00",,"2,42,401.00"',
  '01/07/26,NEFT-ACME PVT LTD-SALARY,,01/07/26,,"1,45,000.00","3,87,401.00"',
  '05/07/26,UPI-SWIGGY-BANGALORE,,05/07/26,920.00,,"3,86,481.00"',
  '06/07/26,POS-CROMA VASHI,,06/07/26,"1,899.00",,"3,84,582.00"',
  '01/08/26,NEFT-ACME PVT LTD-SALARY,,01/08/26,,"1,45,000.00","5,29,582.00"',
  '05/08/26,UPI-SWIGGY-BANGALORE,,05/08/26,890.00,,"5,28,692.00"',
  '14/08/26,POS-CROMA VASHI-ELECTRONICS,,14/08/26,"32,999.00",,"4,95,693.00"',
  "",
].join("\n");

function fakeOllamaOk() {
  return (async (url: string) => {
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "gemma3:4b" }] }), { status: 200 });
    }
    if (url.endsWith("/api/version")) {
      return new Response(JSON.stringify({ version: "0.40.6" }), { status: 200 });
    }
    if (url.endsWith("/api/chat")) {
      // Grounded: ₹1,45,000 is the latest month's income, in the payload.
      return new Response(
        JSON.stringify({ message: { content: "You received ₹1,45,000 in income this month." } }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
}

/** Worker stub: forecast/benchmark echo lag1; amounts = category median. */
const stubWorker: SpawnWorker = async (req: WorkerRequest) => {
  const echo = (set: { test: Array<{ key?: string; lag1: number }> } | undefined) =>
    Object.fromEntries((set?.test ?? []).map((s) => [s.key!, s.lag1]));
  const body = {
    ok: true,
    forecast: echo(req.samples.forecast),
    benchmark: echo(req.samples.benchmark),
    amounts: Object.fromEntries(req.debits.map((d) => [String(d.id), d.categoryMedian])),
    meta: {
      tabpfn: "9.2.0",
      checkpoint: "tabpfn-v3.5-test.safetensors",
      fitSeconds: { forecast: 1.5, benchmark: 0.5, amounts: 2.5 },
    },
  };
  return { code: 0, stdout: JSON.stringify(body), stderr: "" };
};

function tmpSetup() {
  const dir = mkdtempSync(path.join(tmpdir(), "sloth-s12-"));
  const csvPath = path.join(dir, "statement.csv");
  writeFileSync(csvPath, CSV);
  // A cache dir that passes the TabPFN pre-flight: a checkpoint file
  // whose name matches the pattern (content never read — spawn is stubbed).
  const cacheDir = path.join(dir, "cache");
  mkdirSync(cacheDir);
  writeFileSync(path.join(cacheDir, "tabpfn-v3.5-test.safetensors"), "");
  writeFileSync(path.join(dir, "py"), ""); // stands in for venv python + worker
  return { dir, csvPath, cacheDir };
}

const silent = async (fn: () => Promise<number>): Promise<number> => {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
};

describe("runReport (stubbed models)", () => {
  it("runs end to end: artifacts written, CROMA flagged, verdict + metrics in the report", async () => {
    const { dir, csvPath, cacheDir } = tmpSetup();
    const outDir = path.join(dir, "out");
    const code = await silent(() =>
      runReport([csvPath, "--out", outDir, "--memory", path.join(dir, "mem.json")], {
        gemma: { fetchFn: fakeOllamaOk() },
        tabpfn: {
          spawnWorker: stubWorker,
          cacheDir,
          token: "test-token",
          venvPython: path.join(dir, "py"),
          workerPath: path.join(dir, "py"),
        },
      }),
    );
    expect(code).toBe(0);
    const md = readFileSync(path.join(outDir, "report.md"), "utf8");
    expect(md).toContain("₹32,999 at CROMA");
    expect(md).toContain("## Forecast check — held-out Aug 2026 (FR-9)");
    expect(md).toContain("## Run metrics");
    expect(md).toContain("tabpfn 9.2.0");
    const csv = readFileSync(path.join(outDir, "categorized.csv"), "utf8");
    expect(csv.split("\n")[0]).toBe("id,date,description,amount,category,source");
    expect(csv).toContain("POS-CROMA VASHI-ELECTRONICS,-32999.00,Shopping,rule");
    const html = readFileSync(path.join(outDir, "report.html"), "utf8");
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("ground-truth accuracy is computed and printed into the metrics block", async () => {
    const { dir, csvPath, cacheDir } = tmpSetup();
    const gtPath = path.join(dir, "gt.json");
    writeFileSync(
      gtPath,
      JSON.stringify({
        rows: [
          { id: 1, category: "Income" },
          { id: 2, category: "Food & Dining" },
          { id: 9, category: "Shopping" },
        ],
      }),
    );
    const outDir = path.join(dir, "out");
    const code = await silent(() =>
      runReport([csvPath, "--out", outDir, "--memory", path.join(dir, "mem.json"), "--ground-truth", gtPath], {
        gemma: { fetchFn: fakeOllamaOk() },
        tabpfn: {
          spawnWorker: stubWorker,
          cacheDir,
          token: "test-token",
          venvPython: path.join(dir, "py"),
          workerPath: path.join(dir, "py"),
        },
      }),
    );
    expect(code).toBe(0);
    const md = readFileSync(path.join(outDir, "report.md"), "utf8");
    expect(md).toContain("Categorization accuracy vs ground truth: 100.0%");
  });

  it("TabPFN unavailable degrades to notes and still exits 0 with artifacts", async () => {
    const { dir, csvPath } = tmpSetup();
    const outDir = path.join(dir, "out");
    const code = await silent(() =>
      runReport([csvPath, "--out", outDir, "--memory", path.join(dir, "mem.json")], {
        gemma: { fetchFn: fakeOllamaOk() },
        tabpfn: { token: "test-token", venvPython: path.join(dir, "no-such-python") },
      }),
    );
    expect(code).toBe(0);
    const md = readFileSync(path.join(outDir, "report.md"), "utf8");
    expect(md).toContain("Forecast unavailable because Python venv not found");
    expect(md).toContain("Anomaly detection unavailable because");
  });

  it("Ollama down is fatal: exit 1 and no artifacts (SPEC failure mode)", async () => {
    const { dir, csvPath, cacheDir } = tmpSetup();
    const outDir = path.join(dir, "out");
    const downFetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    const code = await silent(() =>
      runReport([csvPath, "--out", outDir, "--memory", path.join(dir, "mem.json")], {
        gemma: { fetchFn: downFetch },
        tabpfn: {
          spawnWorker: stubWorker,
          cacheDir,
          token: "test-token",
          venvPython: path.join(dir, "py"),
          workerPath: path.join(dir, "py"),
        },
      }),
    );
    expect(code).toBe(1);
    expect(existsSync(path.join(outDir, "report.md"))).toBe(false);
  });

  it("garbage input exits 1 with no artifacts", async () => {
    const { dir } = tmpSetup();
    const badPath = path.join(dir, "bad.csv");
    writeFileSync(badPath, "hello,world\n1,2\n");
    const outDir = path.join(dir, "out");
    const code = await silent(() =>
      runReport([badPath, "--out", outDir], { gemma: { fetchFn: fakeOllamaOk() } }),
    );
    expect(code).toBe(1);
    expect(existsSync(path.join(outDir, "report.md"))).toBe(false);
  });
});
