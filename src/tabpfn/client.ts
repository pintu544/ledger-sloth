// TabPFN client (DESIGN §2): pre-flight, deterministic sample
// builders (DESIGN §3), and the spawn-per-run stdio protocol.
//
// TS builds every feature; Python only fits/predicts. Pre-flight
// order is DESIGN's: license token -> venv python -> checkpoint.
// Any failure — pre-flight, spawn, bad output, timeout — surfaces
// as a typed TabpfnUnavailable with a one-line human reason, so the
// report degrades explicitly instead of fabricating numbers.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { median } from "../aggregate.js";
import { merchantKey } from "../categorize/memory.js";
import {
  TabpfnUnavailable,
  type Aggregates,
  type CategorizedTxn,
  type Category,
  type CategoryMonthTotal,
} from "../types.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_TIMEOUT_MS = 900_000; // inference is minutes-scale (S1 spike)
export const CHECKPOINT_PATTERN = /^tabpfn-v3\.5-.*\.safetensors$/;

/** One sliding training/test sample for the pooled regressor (DESIGN §3). */
export interface MonthlySample {
  category: Category;
  monthIndex: number;
  monthOfYear: number;
  lag1: number;
  rollMean: number;
  /** Training rows only. */
  target?: number;
  /** Test rows only: the category the prediction belongs to. */
  key?: string;
}

export interface SampleSet {
  train: MonthlySample[];
  test: MonthlySample[];
}

/** One debit in the DESIGN §2 worker-protocol shape (features pre-built). */
export interface DebitFeatures {
  id: number;
  month: string;
  date: string;
  description: string;
  category: Category;
  /** Positive magnitude (money out). */
  amount: number;
  dayOfMonth: number;
  /** 0 = Sunday … 6 = Saturday (JS getUTCDay; DESIGN §2 example: Mon 2026-09-14 -> 1). */
  weekday: number;
  merchantKey: string;
  categoryMedian: number;
  merchantMedian: number;
}

export interface WorkerRequest {
  jobs: string[];
  monthlyTotals: CategoryMonthTotal[];
  debits: DebitFeatures[];
  samples: { forecast?: SampleSet; benchmark?: SampleSet };
}

export interface WorkerMeta {
  tabpfn: string;
  checkpoint: string;
  fitSeconds: Record<string, number>;
}

export interface TabpfnResult {
  /** Per-category next-month spend forecast; null when not run. */
  forecast: Record<string, number> | null;
  /** Per-category predictions for the held-out last month; null when < 3 months. */
  benchmark: Record<string, number> | null;
  /** Expected amount per debit, keyed by transaction id (string). */
  amounts: Record<string, number>;
  /** True when the statement has < 2 months — forecast section must say so (SPEC). */
  forecastSkipped: boolean;
  meta: WorkerMeta | null;
}

export type SpawnWorker = (
  req: WorkerRequest,
  opts: { pythonPath: string; workerPath: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface TabpfnOptions {
  token?: string;
  venvPython?: string;
  workerPath?: string;
  cacheDir?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  spawnWorker?: SpawnWorker;
}

interface ResolvedOptions {
  token: string | undefined;
  venvPython: string;
  workerPath: string;
  cacheDir: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  spawnWorker: SpawnWorker;
}

function resolveOptions(opts: TabpfnOptions): ResolvedOptions {
  const env = opts.env ?? process.env;
  return {
    token: opts.token ?? env.TABPFN_TOKEN,
    venvPython: opts.venvPython ?? path.join(PROJECT_ROOT, "python", ".venv", "bin", "python"),
    workerPath: opts.workerPath ?? path.join(PROJECT_ROOT, "python", "worker.py"),
    cacheDir: opts.cacheDir ?? path.join(homedir(), ".cache", "tabpfn"),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env,
    spawnWorker: opts.spawnWorker ?? defaultSpawnWorker,
  };
}

/** DESIGN §2 pre-flight, in order. Throws TabpfnUnavailable — never spawns on a miss. */
export function preflightTabpfn(opts: TabpfnOptions = {}): void {
  const o = resolveOptions(opts);
  const cachedToken = path.join(o.cacheDir, "auth_token");
  if ((!o.token || o.token.trim() === "") && !existsSync(cachedToken)) {
    throw new TabpfnUnavailable(
      "TABPFN_TOKEN is not set and no cached TabPFN license token was found — " +
        "accept the license and set TABPFN_TOKEN (see TABPFN-SIGNUP-STEPS.md)",
    );
  }
  if (!existsSync(o.venvPython)) {
    throw new TabpfnUnavailable(
      `Python venv not found at ${o.venvPython} — create it and install python/requirements.txt ` +
        "(CPU-only torch first, per the note in that file)",
    );
  }
  if (!existsSync(o.workerPath)) {
    throw new TabpfnUnavailable(`TabPFN worker script not found at ${o.workerPath}`);
  }
  let checkpoint: string | undefined;
  try {
    checkpoint = readdirSync(o.cacheDir).find((f) => CHECKPOINT_PATTERN.test(f));
  } catch {
    checkpoint = undefined;
  }
  if (!checkpoint) {
    throw new TabpfnUnavailable(
      `TabPFN-3.5 checkpoint not found in ${o.cacheDir} — it downloads once, with ` +
        "TABPFN_TOKEN set and network available, the first time the model runs",
    );
  }
}

// ---------------------------------------------------------------------------
// Deterministic sample builders (DESIGN §3). The statement's months
// form a grid: a category absent in a month spent 0 that month.
// Income is never a spend forecast, so it never enters the samples.
// ---------------------------------------------------------------------------

interface TotalsGrid {
  months: string[];
  categories: Category[];
  /** grid.get(category)[monthIndex] = total spend (0 when absent). */
  grid: Map<Category, number[]>;
}

export function totalsGrid(monthlyTotals: readonly CategoryMonthTotal[]): TotalsGrid {
  const spend = monthlyTotals.filter((t) => t.category !== "Income");
  const months = [...new Set(spend.map((t) => t.month))].sort();
  const categories = [...new Set(spend.map((t) => t.category))].sort((a, b) =>
    a.localeCompare(b),
  );
  const grid = new Map<Category, number[]>();
  for (const category of categories) grid.set(category, months.map(() => 0));
  for (const cell of spend) {
    grid.get(cell.category)![months.indexOf(cell.month)] = cell.total;
  }
  return { months, categories, grid };
}

const monthOfYear = (month: string): number => Number(month.slice(5, 7));

function sampleAt(g: TotalsGrid, category: Category, targetIndex: number): MonthlySample {
  const totals = g.grid.get(category)!;
  const prev = totals.slice(Math.max(0, targetIndex - 2), targetIndex);
  const rollMean = prev.reduce((s, v) => s + v, 0) / prev.length;
  const moy =
    targetIndex < g.months.length
      ? monthOfYear(g.months[targetIndex])
      : (monthOfYear(g.months[g.months.length - 1]) % 12) + 1;
  return {
    category,
    monthIndex: targetIndex,
    monthOfYear: moy,
    lag1: totals[targetIndex - 1],
    rollMean: Math.round(rollMean * 100) / 100,
  };
}

/** Train on target months 1..N-1; predict month N (the forecast). */
export function buildForecastSamples(monthlyTotals: readonly CategoryMonthTotal[]): SampleSet {
  const g = totalsGrid(monthlyTotals);
  const n = g.months.length;
  const train: MonthlySample[] = [];
  const test: MonthlySample[] = [];
  for (const category of g.categories) {
    for (let i = 1; i < n; i++) {
      train.push({ ...sampleAt(g, category, i), target: g.grid.get(category)![i] });
    }
    test.push({ ...sampleAt(g, category, n), key: category });
  }
  return { train, test };
}

/** Same builder, cutoff moved: train on target months ≤ N-2, predict month N-1. */
export function buildBenchmarkSamples(monthlyTotals: readonly CategoryMonthTotal[]): SampleSet {
  const g = totalsGrid(monthlyTotals);
  const n = g.months.length;
  const train: MonthlySample[] = [];
  const test: MonthlySample[] = [];
  for (const category of g.categories) {
    for (let i = 1; i <= n - 2; i++) {
      train.push({ ...sampleAt(g, category, i), target: g.grid.get(category)![i] });
    }
    test.push({ ...sampleAt(g, category, n - 1), key: category });
  }
  return { train, test };
}

/** Per-debit feature rows for the amounts job (DESIGN §2/§3). */
export function buildDebits(
  txns: readonly CategorizedTxn[],
  aggregates: Aggregates,
): DebitFeatures[] {
  const debitTxns = txns.filter((t) => t.amount < 0);
  const byMerchant = new Map<string, number[]>();
  for (const t of debitTxns) {
    const key = merchantKey(t.description);
    const list = byMerchant.get(key) ?? [];
    list.push(-t.amount);
    byMerchant.set(key, list);
  }
  const merchantMedians = new Map(
    [...byMerchant.entries()].map(([k, v]) => [k, median(v)] as const),
  );
  const categoryMedians = new Map(
    aggregates.byCategory.map((c) => [c.category, c.medianDebit] as const),
  );
  return debitTxns.map((t) => {
    const key = merchantKey(t.description);
    return {
      id: t.id,
      month: t.date.slice(0, 7),
      date: t.date,
      description: t.description,
      category: t.category,
      amount: -t.amount,
      dayOfMonth: Number(t.date.slice(8, 10)),
      weekday: new Date(`${t.date}T00:00:00Z`).getUTCDay(),
      merchantKey: key,
      categoryMedian: categoryMedians.get(t.category) ?? 0,
      merchantMedian: merchantMedians.get(key) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Spawn (DESIGN §2: once per run, one JSON document over stdio).
// ---------------------------------------------------------------------------

function defaultSpawnWorker(
  req: WorkerRequest,
  opts: { pythonPath: string; workerPath: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.pythonPath, [opts.workerPath], {
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // The caller races its own timeout; this timer is the backstop
    // that makes sure a hung worker never lingers as a zombie.
    const killer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs + 5_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(req));
  });
}

const stderrTail = (stderr: string): string => {
  const lines = stderr.trim().split("\n").filter((l) => l.trim() !== "");
  return (lines[lines.length - 1] ?? "no stderr output").slice(0, 300);
};

/**
 * Run the TabPFN stage. Throws TabpfnUnavailable (with a one-line
 * reason) whenever the model cannot run — the caller degrades the
 * forecast/anomaly sections with that reason, per SPEC.
 */
export async function runTabpfn(
  txns: readonly CategorizedTxn[],
  aggregates: Aggregates,
  opts: TabpfnOptions = {},
): Promise<TabpfnResult> {
  const o = resolveOptions(opts);
  preflightTabpfn(opts);

  const months = aggregates.months;
  const spendTotals = aggregates.monthlyTotals.filter((t) => t.category !== "Income");
  const debits = buildDebits(txns, aggregates);

  const jobs: string[] = [];
  const samples: WorkerRequest["samples"] = {};
  if (months.length >= 2 && spendTotals.length > 0) {
    jobs.push("forecast");
    samples.forecast = buildForecastSamples(spendTotals);
  }
  if (months.length >= 3 && spendTotals.length > 0) {
    jobs.push("benchmark");
    samples.benchmark = buildBenchmarkSamples(spendTotals);
  }
  if (debits.length > 0) jobs.push("amounts");

  const skipped: TabpfnResult = {
    forecast: null,
    benchmark: null,
    amounts: {},
    forecastSkipped: months.length < 2,
    meta: null,
  };
  if (jobs.length === 0) return skipped;

  const req: WorkerRequest = { jobs, monthlyTotals: spendTotals, debits, samples };

  let outcome: { code: number; stdout: string; stderr: string };
  let timer: NodeJS.Timeout | undefined;
  try {
    outcome = await Promise.race([
      o.spawnWorker(req, {
        pythonPath: o.venvPython,
        workerPath: o.workerPath,
        env: o.env,
        timeoutMs: o.timeoutMs,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`TabPFN worker timed out after ${Math.round(o.timeoutMs / 1000)}s`),
            ),
          o.timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    throw new TabpfnUnavailable(err instanceof Error ? err.message : String(err));
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (outcome.code !== 0) {
    throw new TabpfnUnavailable(`TabPFN worker failed: ${stderrTail(outcome.stderr)}`);
  }
  let resp: {
    ok?: boolean;
    error?: string;
    forecast?: Record<string, number>;
    benchmark?: Record<string, number>;
    amounts?: Record<string, number>;
    meta?: WorkerMeta;
  };
  try {
    resp = JSON.parse(outcome.stdout);
  } catch {
    throw new TabpfnUnavailable("TabPFN worker returned invalid JSON on stdout");
  }
  if (!resp.ok) {
    throw new TabpfnUnavailable(`TabPFN worker reported: ${resp.error ?? "unknown error"}`);
  }

  return {
    forecast: jobs.includes("forecast") ? (resp.forecast ?? {}) : null,
    benchmark: jobs.includes("benchmark") ? (resp.benchmark ?? {}) : null,
    amounts: resp.amounts ?? {},
    forecastSkipped: months.length < 2,
    meta: resp.meta ?? null,
  };
}
