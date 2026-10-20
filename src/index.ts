// Ledger Sloth CLI (DESIGN §4).
//   report <csv> [--memory <path>] [--out <dir>] [--ground-truth <path>]
//     — the full pipeline (DESIGN §1): parse -> deterministic
//     categorize -> Gemma (leftovers + narrative) -> aggregates ->
//     TabPFN (forecast + benchmark + anomalies) -> report.md,
//     report.html, categorized.csv. Fatal conditions print a plain
//     message with the fix and exit non-zero with no artifacts;
//     TabPFN failure degrades its sections instead (SPEC §6).
//   correct "<pattern>" <Category> [--memory <path>]
//     — SPEC FR-4: teach the local correction memory (S5).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStatement } from "./parse/normalize.js";
import { addCorrection, loadMemory } from "./categorize/memory.js";
import { CATEGORIES, isCategory } from "./categorize/categories.js";
import { categorizeDeterministic } from "./categorize/categorize.js";
import {
  categorizeWithGemma,
  generateNarrative,
  preflightGemma,
  DEFAULT_MODEL,
  type GemmaOptions,
} from "./categorize/gemma.js";
import { aggregate } from "./aggregate.js";
import { buildDebits, runTabpfn, type TabpfnOptions } from "./tabpfn/client.js";
import { computeBenchmarkVerdict, flagAnomalies } from "./tabpfn/analyze.js";
import { renderReport, type ReportData } from "./report/render.js";
import { renderHtml } from "./report/html.js";
import { renderCategorizedCsv } from "./report/csvOut.js";
import { StageTimer, checkpointInfo, dirSizeBytes, hostLine, toMb } from "./metrics.js";
import { fmtINR } from "./format.js";
import {
  OllamaUnavailable,
  ParseError,
  TabpfnUnavailable,
  UnrecognizedColumns,
  type Anomaly,
  type BenchmarkVerdict,
  type CategorizedTxn,
  type ForecastOutcome,
  type RunMetrics,
} from "./types.js";

export const DEFAULT_MEMORY_PATH = "ledger-sloth-memory.json";

const PROJECT_ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

const USAGE = `Usage:
  ledger-sloth report <statement.csv> [--memory <path>] [--out <dir>] [--ground-truth <path>]
  ledger-sloth correct "<pattern>" <Category> [--memory <path>]

Categories: ${CATEGORIES.join(", ")}`;

const round2 = (n: number): number => Math.round(n * 100) / 100;

function takeFlag(args: string[], flag: string): { value: string | null; rest: string[] } {
  const i = args.indexOf(flag);
  if (i === -1) return { value: null, rest: args };
  const value = args[i + 1];
  if (value === undefined) throw new Error(`Flag ${flag} needs a value.`);
  return { value, rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

/** Run the `correct` subcommand. Returns the process exit code. */
export function runCorrect(args: string[]): number {
  const { value: memoryPath, rest } = takeFlag(args, "--memory");
  const [pattern, categoryRaw] = rest;
  if (!pattern || !categoryRaw || rest.length > 2) {
    console.error(USAGE);
    return 2;
  }
  if (!isCategory(categoryRaw)) {
    console.error(
      `"${categoryRaw}" is not one of the fixed categories.\nCategories: ${CATEGORIES.join(", ")}`,
    );
    return 2;
  }
  const path = memoryPath ?? DEFAULT_MEMORY_PATH;
  const entries = addCorrection(path, pattern, categoryRaw);
  console.log(
    `Recorded: "${pattern}" -> ${categoryRaw} (${entries.length} correction${entries.length === 1 ? "" : "s"} in ${path}).`,
  );
  return 0;
}

// ---------------------------------------------------------------------------

export interface ReportDeps {
  gemma?: GemmaOptions;
  tabpfn?: TabpfnOptions;
}

/** Run the `report` subcommand. Returns the process exit code. */
export async function runReport(args: string[], deps: ReportDeps = {}): Promise<number> {
  let rest = args;
  let memoryPath: string | null = null;
  let outDir = "out";
  let groundTruthPath: string | null = null;
  try {
    ({ value: memoryPath, rest } = takeFlag(rest, "--memory"));
    let out: string | null;
    ({ value: out, rest } = takeFlag(rest, "--out"));
    if (out !== null) outDir = out;
    ({ value: groundTruthPath, rest } = takeFlag(rest, "--ground-truth"));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const [csvPath] = rest;
  if (!csvPath || rest.length > 1) {
    console.error(USAGE);
    return 2;
  }

  const timer = new StageTimer();
  const runStart = performance.now();
  try {
    let csvText: string;
    try {
      csvText = readFileSync(csvPath, "utf8");
    } catch {
      console.error(`Could not read ${csvPath}. Check the path and try again.`);
      return 1;
    }
    const { txns, excluded } = await timer.time("parse", () => parseStatement(csvText));
    const memory = loadMemory(memoryPath ?? DEFAULT_MEMORY_PATH);

    const det = await timer.time("rulesMemory", () =>
      categorizeDeterministic(txns, memory),
    );
    let gemmaRequests = 0;
    let gemmaCategorized: CategorizedTxn[] = [];
    if (det.leftovers.length > 0) {
      const g = await timer.time("gemmaCategorize", () =>
        categorizeWithGemma(det.leftovers, deps.gemma),
      );
      gemmaCategorized = g.categorized;
      gemmaRequests = g.metrics.requests;
    }
    const categorized = [...det.categorized, ...gemmaCategorized].sort(
      (a, b) => a.id - b.id,
    );
    const aggregates = await timer.time("aggregate", () => aggregate(categorized));

    // TabPFN stage — degraded, never fatal (DESIGN §6).
    let tabpfnVersion: string | null = null;
    let tabpfnFitSeconds: Record<string, number> | null = null;
    let verdict: BenchmarkVerdict | null = null;
    let anomalies: Anomaly[] = [];
    let outcome: ForecastOutcome;
    try {
      const result = await timer.time("tabpfn", () =>
        runTabpfn(categorized, aggregates, deps.tabpfn),
      );
      tabpfnVersion = result.meta?.tabpfn ?? null;
      tabpfnFitSeconds = result.meta?.fitSeconds ?? null;
      anomalies = flagAnomalies(buildDebits(categorized, aggregates), result.amounts);
      verdict = computeBenchmarkVerdict(result, aggregates);
      outcome = result.forecast
        ? { kind: "ok", forecast: result.forecast, verdict, anomalies }
        : { kind: "insufficient-history", anomalies };
    } catch (err) {
      if (!(err instanceof TabpfnUnavailable)) throw err;
      outcome = { kind: "unavailable", reason: err.message };
    }

    const months = aggregates.months;
    const latestMonth = months[months.length - 1];
    const latestMonthIncome = round2(
      categorized
        .filter((t) => t.date.startsWith(latestMonth) && t.amount > 0)
        .reduce((s, t) => s + t.amount, 0),
    );

    const narrative = await timer.time("narrative", () =>
      generateNarrative(
        {
          aggregates,
          latestMonthIncome,
          anomalies,
          forecast: outcome.kind === "ok" ? outcome.forecast : null,
          forecastNote:
            outcome.kind === "unavailable"
              ? `TabPFN unavailable because ${outcome.reason}`
              : outcome.kind === "insufficient-history"
                ? "at least two months of history are needed for a forecast"
                : null,
          benchmark: verdict
            ? {
                heldOutMonth: verdict.heldOutMonth,
                tabpfnMae: verdict.tabpfnMae,
                naiveMae: verdict.naiveMae,
                winner: verdict.winner,
              }
            : null,
        },
        deps.gemma,
      ),
    );

    let accuracyPct: number | null = null;
    if (groundTruthPath) {
      const parsed: unknown = JSON.parse(readFileSync(groundTruthPath, "utf8"));
      const rows = (
        Array.isArray(parsed)
          ? parsed
          : ((parsed as { rows?: unknown }).rows ?? [])
      ) as Array<{ id: number; category: string }>;
      const byId = new Map(categorized.map((t) => [t.id, t.category]));
      const correct = rows.filter((r) => byId.get(r.id) === r.category).length;
      accuracyPct =
        rows.length > 0 ? Math.round((correct / rows.length) * 1000) / 10 : null;
    }

    // Ollama version is metrics-only — a soft lookup, never a failure.
    let ollamaVersion: string | null = null;
    try {
      ollamaVersion = (await preflightGemma(deps.gemma)).version;
    } catch {
      ollamaVersion = null;
    }

    const cacheDir = deps.tabpfn?.cacheDir ?? path.join(homedir(), ".cache", "tabpfn");
    const ckpt = checkpointInfo(cacheDir);
    const countSource = (s: CategorizedTxn["source"]): number =>
      categorized.filter((t) => t.source === s).length;
    const metrics: RunMetrics = {
      rowsParsed: txns.length,
      rowsExcluded: excluded,
      stageSeconds: {
        parse: timer.seconds("parse"),
        rulesMemory: timer.seconds("rulesMemory"),
        gemmaCategorize: timer.seconds("gemmaCategorize"),
        aggregate: timer.seconds("aggregate"),
        tabpfn: timer.seconds("tabpfn"),
        narrative: timer.seconds("narrative"),
        render: 0,
        total: 0,
      },
      gemmaRequests: gemmaRequests + narrative.requests,
      sourceCounts: {
        memory: countSource("memory"),
        rule: countSource("rule"),
        gemma: countSource("gemma"),
        other: countSource("other"),
      },
      gemmaModel: deps.gemma?.model ?? DEFAULT_MODEL,
      ollamaVersion,
      tabpfnVersion,
      tabpfnFitSeconds,
      checkpoint: ckpt?.name ?? null,
      checkpointMb: toMb(ckpt?.bytes ?? null),
      pythonEnvMb: toMb(dirSizeBytes(path.join(PROJECT_ROOT, "python", ".venv"))),
      hostLine: hostLine(),
      narrativeSource: narrative.source,
      narrativeAttempts: narrative.attempts,
      narrativeInventedFigures: narrative.inventedFigures,
      accuracyPct,
      verdict,
    };
    const data: ReportData = {
      statementName: path.basename(csvPath),
      narrative,
      aggregates,
      latestMonthIncome,
      outcome,
      metrics,
    };

    // Render is timed by a discarded first pass so the printed number
    // is the real render cost; the second pass carries it.
    const renderStart = performance.now();
    renderReport(data);
    metrics.stageSeconds.render = round2((performance.now() - renderStart) / 1000);
    metrics.stageSeconds.total = round2((performance.now() - runStart) / 1000);
    const md = renderReport(data);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "report.md"), md);
    writeFileSync(path.join(outDir, "report.html"), renderHtml(md));
    writeFileSync(path.join(outDir, "categorized.csv"), renderCategorizedCsv(categorized));

    console.log(
      `Report written: ${path.join(outDir, "report.md")} (+ report.html, categorized.csv)`,
    );
    if (outcome.kind !== "unavailable") {
      console.log(`Anomalies flagged: ${outcome.anomalies.length}`);
    }
    if (verdict) {
      console.log(
        `Forecast check (held-out ${verdict.heldOutMonth}): TabPFN MAE ${fmtINR(verdict.tabpfnMae)} ` +
          `vs naive MAE ${fmtINR(verdict.naiveMae)} — ${
            verdict.winner === "tie"
              ? "tie"
              : verdict.winner === "TabPFN"
                ? "TabPFN won"
                : "naive baseline won"
          }`,
      );
    }
    if (accuracyPct !== null) {
      console.log(`Categorization accuracy vs ground truth: ${accuracyPct.toFixed(1)}%`);
    }
    return 0;
  } catch (err) {
    if (
      err instanceof ParseError ||
      err instanceof UnrecognizedColumns ||
      err instanceof OllamaUnavailable
    ) {
      console.error(err.message);
      return 1;
    }
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "correct":
      return runCorrect(rest);
    case "report":
      return runReport(rest);
    default:
      console.error(USAGE);
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
