// Gemma stage of the categorize pipeline (DESIGN §1 stage [3], §4):
// an Ollama client over Node 24 fetch — no SDK, three endpoints.
//
// Trust discipline (S2 spike finding, spec/research.md): the batch
// reply's category array drifted from input order in the ad-hoc
// benchmark, so this client never trusts a reply blindly —
//   * the reply must be a JSON array of EXACTLY the batch length
//     (otherwise the batch is retried once, then every row falls
//     back to Other and the failure is counted, never hidden);
//   * results are mapped positionally only after that validation;
//   * every element must be a member of the fixed category list —
//     an invalid element degrades just that row to Other (SPEC §6).
// The stage's final request sends keep_alive: 0 so Gemma unloads
// before the TabPFN stage — sequential residency is structural
// (DESIGN §1/§2), and this is where the TS side enforces its half.

import { CATEGORIES, isCategory } from "./categories.js";
import { fmtINR } from "../format.js";
import {
  OllamaUnavailable,
  type Aggregates,
  type Anomaly,
  type CategorizedTxn,
  type Category,
  type Txn,
} from "../types.js";

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_MODEL = "gemma3:4b";
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_TIMEOUT_MS = 300_000;

export interface GemmaOptions {
  baseUrl?: string;
  model?: string;
  fetchFn?: typeof fetch;
  batchSize?: number;
  timeoutMs?: number;
}

export interface GemmaPreflight {
  models: string[];
  version: string | null;
}

export interface GemmaMetrics {
  requests: number;
  invalidRows: number;
  failedBatches: number;
  /** Rows categorized by a valid Gemma reply vs the Other fallback. */
  sourceCounts: { gemma: number; other: number };
}

function resolveOptions(opts: GemmaOptions): Required<GemmaOptions> {
  return {
    baseUrl: (opts.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/$/, ""),
    model: opts.model ?? DEFAULT_MODEL,
    fetchFn: opts.fetchFn ?? fetch,
    batchSize: opts.batchSize ?? DEFAULT_BATCH_SIZE,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

const serverDown = (baseUrl: string): OllamaUnavailable =>
  new OllamaUnavailable(
    `Ollama is not running — nothing answered at ${baseUrl}. ` +
      `Start it with:\n  ollama serve\nthen re-run. (Ledger Sloth talks to Ollama on localhost only.)`,
  );

const modelMissing = (model: string): OllamaUnavailable =>
  new OllamaUnavailable(
    `Ollama is running but the model "${model}" is not pulled. Fetch it with:\n  ollama pull ${model}\nthen re-run.`,
  );

/** Pre-flight (SPEC failure mode): server-down vs model-missing. */
export async function preflightGemma(opts: GemmaOptions = {}): Promise<GemmaPreflight> {
  const { baseUrl, model, fetchFn, timeoutMs } = resolveOptions(opts);
  let tagsRes: Response;
  try {
    tagsRes = await fetchFn(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw serverDown(baseUrl);
  }
  if (!tagsRes.ok) throw serverDown(baseUrl);
  const tags = (await tagsRes.json()) as { models?: Array<{ name?: string }> };
  const models = (tags.models ?? []).map((m) => m.name ?? "").filter((n) => n !== "");
  const present = models.some((n) => n === model || n.startsWith(`${model}:`) || model.startsWith(`${n}:`));
  if (!present) throw modelMissing(model);

  let version: string | null = null;
  try {
    const v = await fetchFn(`${baseUrl}/api/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (v.ok) version = ((await v.json()) as { version?: string }).version ?? null;
  } catch {
    version = null; // best effort only — metrics, not a gate
  }
  return { models, version };
}

const SYSTEM_PROMPT =
  "You categorize Indian bank statement narrations. Reply with ONLY a JSON array of " +
  "category strings — one per numbered narration, in the same order, nothing else. " +
  `Each element must be exactly one of: ${CATEGORIES.join(", ")}.`;

function batchPrompt(batch: readonly Txn[]): string {
  const lines = batch.map((t, i) => {
    const kind = t.amount < 0 ? `debit ${Math.abs(t.amount).toFixed(2)}` : `credit ${t.amount.toFixed(2)}`;
    return `${i + 1}. ${t.description} (${kind})`;
  });
  return `Categorize these ${batch.length} narrations:\n${lines.join("\n")}`;
}

/** Extract the first JSON array from a model reply, or null. */
function extractJsonArray(content: string): unknown[] | null {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(content.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function requestBatch(
  batch: readonly Txn[],
  isFinal: boolean,
  cfg: Required<GemmaOptions>,
): Promise<unknown[] | null> {
  const res = await cfg.fetchFn(`${cfg.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      options: { temperature: 0 },
      keep_alive: isFinal ? 0 : "5m",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: batchPrompt(batch) },
      ],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { message?: { content?: string } };
  const content = body.message?.content;
  if (typeof content !== "string") return null;
  return extractJsonArray(content);
}

/**
 * Categorize leftover transactions with Gemma. Every input row comes
 * back with exactly one valid category: rows the model answered
 * validly get source "gemma"; rows lost to an invalid element or a
 * failed batch get "Other" with source "other", counted in metrics.
 * Throws OllamaUnavailable when the pre-flight fails.
 */
export async function categorizeWithGemma(
  txns: readonly Txn[],
  opts: GemmaOptions = {},
): Promise<{ categorized: CategorizedTxn[]; metrics: GemmaMetrics }> {
  const cfg = resolveOptions(opts);
  const metrics: GemmaMetrics = {
    requests: 0,
    invalidRows: 0,
    failedBatches: 0,
    sourceCounts: { gemma: 0, other: 0 },
  };
  const categorized: CategorizedTxn[] = [];
  if (txns.length === 0) return { categorized, metrics };

  await preflightGemma(opts);

  const batches: Txn[][] = [];
  for (let i = 0; i < txns.length; i += cfg.batchSize) {
    batches.push(txns.slice(i, i + cfg.batchSize));
  }

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const isFinal = b === batches.length - 1;
    let reply: unknown[] | null = null;
    // One retry for an unparseable / wrong-length reply, then the
    // batch degrades honestly instead of being mapped on faith.
    for (let attempt = 0; attempt < 2 && reply === null; attempt++) {
      metrics.requests++;
      try {
        const candidate = await requestBatch(batch, isFinal, cfg);
        if (candidate !== null && candidate.length === batch.length) reply = candidate;
      } catch {
        reply = null;
      }
    }
    if (reply === null) {
      metrics.failedBatches++;
      metrics.invalidRows += batch.length;
      for (const txn of batch) {
        categorized.push({ ...txn, category: "Other", source: "other" });
        metrics.sourceCounts.other++;
      }
      continue;
    }
    batch.forEach((txn, i) => {
      const value: unknown = reply[i];
      if (isCategory(value)) {
        categorized.push({ ...txn, category: value, source: "gemma" });
        metrics.sourceCounts.gemma++;
      } else {
        categorized.push({ ...txn, category: "Other", source: "other" });
        metrics.sourceCounts.other++;
        metrics.invalidRows++;
      }
    });
  }
  return { categorized, metrics };
}

// ---------------------------------------------------------------------------
// Narrative (SPEC FR-6, DESIGN §7): the month-in-review, grounded by
// construction and then VERIFIED. The prompt contains only the
// aggregates JSON; after generation, every ₹-figure in the text is
// extracted and checked against that JSON. A failed check retries
// once with a sterner prompt; a second failure substitutes a
// deterministic templated summary. The model proposes; the code
// disposes.
// ---------------------------------------------------------------------------

export interface NarrativeInput {
  aggregates: Aggregates;
  /** Credits received in the latest month (Aggregates tracks spend
   * per month; the caller computes income from the transactions). */
  latestMonthIncome: number;
  anomalies: readonly Anomaly[];
  /** Next-month forecast per category (raw model output), or null. */
  forecast: Record<string, number> | null;
  /** Why there is no forecast (unavailable / insufficient history), or null. */
  forecastNote: string | null;
  benchmark: {
    heldOutMonth: string;
    tabpfnMae: number;
    naiveMae: number;
    winner: string;
  } | null;
}

export interface NarrativeResult {
  text: string;
  source: "gemma" | "template";
  /** Gemma attempts made (1 or 2); 2 with source "template" means both failed grounding. */
  attempts: number;
  /** ₹ figures that failed the grounding check on failed attempts. */
  inventedFigures: number[];
  requests: number;
}

/** The JSON document the narrative prompt is allowed to see — nothing else. */
export function buildNarrativePayload(input: NarrativeInput): Record<string, unknown> {
  const { aggregates: aggs, anomalies, forecast, forecastNote, benchmark } = input;
  const latestMonth = aggs.months[aggs.months.length - 1];
  const latestTotals = aggs.monthlyTotals.filter((t) => t.month === latestMonth);
  const latestDeltas = aggs.deltas.filter((d) => d.month === latestMonth);
  return {
    months: aggs.months,
    latestMonth,
    latestMonthSpendByCategory: latestTotals
      .filter((t) => t.category !== "Income")
      .map((t) => ({ category: t.category, totalSpend: t.total, transactions: t.count })),
    // A derived total, computed by TS from the same aggregates —
    // part of the data, so a narrative citing it is grounded.
    latestMonthTotalSpend: latestTotals
      .filter((t) => t.category !== "Income")
      .reduce((s, t) => s + t.total, 0),
    latestMonthIncome: input.latestMonthIncome,
    wholePeriodByCategory: aggs.byCategory.map((c) => ({
      category: c.category,
      totalSpend: c.debits,
      totalIn: c.credits,
      transactions: c.count,
      medianDebit: c.medianDebit,
    })),
    monthOverMonthIntoLatest: latestDeltas.map((d) => ({
      category: d.category,
      change: d.delta,
      pctChange: d.pct,
    })),
    topMerchants: aggs.topMerchants.map((m) => ({
      merchant: m.merchantKey,
      totalSpend: m.debits,
      transactions: m.count,
    })),
    anomalies: anomalies.map((a) => ({
      date: a.date,
      description: a.description,
      amount: a.amount,
      expected: a.expected,
      reason: a.reason,
    })),
    forecastNextMonth: forecast,
    forecastNote,
    benchmark,
  };
}

/** Every ₹-figure in a text, as numbers ("₹1,45,000" -> 145000). */
export function extractRupeeFigures(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/₹\s*([\d][\d,]*(?:\.\d+)?)/g)) {
    const v = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * The figures a narrative may legitimately use: every number in the
 * payload, its whole-rupee rounding, and any ₹ figures already
 * inside payload strings (anomaly reason strings carry rounded
 * expectations).
 */
export function collectAllowedFigures(payload: unknown): Set<number> {
  const allowed = new Set<number>();
  const walk = (v: unknown): void => {
    if (typeof v === "number" && Number.isFinite(v)) {
      allowed.add(v);
      allowed.add(Math.round(v));
    } else if (typeof v === "string") {
      for (const f of extractRupeeFigures(v)) allowed.add(f);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v !== null && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  walk(payload);
  return allowed;
}

const figuresAreGrounded = (text: string, allowed: ReadonlySet<number>): number[] =>
  extractRupeeFigures(text).filter(
    (f) => ![...allowed].some((a) => Math.abs(a - f) < 0.005),
  );

/** Raw ₹-figure tokens exactly as written ("1,45,000"), for format checks. */
export function extractRupeeFigureTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/₹\s*([\d][\d,]*(?:\.\d+)?)/g)) out.push(m[1]);
  return out;
}

const INDIAN_GROUPING = /^\d{1,2}(,\d{2})*,\d{3}(\.\d+)?$/;
const INTERNATIONAL_GROUPING = /^\d{1,3}(,\d{3})+(\.\d+)?$/;

/**
 * A comma-grouped token is well-formed iff it follows Indian grouping
 * (1,45,000) or international grouping (145,000). The S13 sweep
 * caught Gemma writing "₹11,1622" — the value (111622) exists in the
 * data, so value-only grounding passed a number no reader can parse.
 */
export function isWellFormedFigureToken(token: string): boolean {
  if (!token.includes(",")) return true;
  return INDIAN_GROUPING.test(token) || INTERNATIONAL_GROUPING.test(token);
}

/** ₹ values in the text whose written grouping is malformed. */
const malformedFigures = (text: string): number[] =>
  extractRupeeFigureTokens(text)
    .filter((t) => !isWellFormedFigureToken(t))
    .map((t) => Number(t.replace(/,/g, "")))
    .filter((v) => Number.isFinite(v));

const PERIOD_MARKER =
  /across|overall|in total|whole period|combined|statement period|over the period|all \d+ months/i;

/**
 * Scope check (S13): a figure whose ONLY source in the payload is a
 * whole-period scope (wholePeriodByCategory / topMerchants) is
 * legitimate when framed as a period total, but misleading when a
 * sentence attaches it to the reviewed month or a monthly change —
 * the live failure was "a significant increase of ₹52,740", where
 * ₹52,740 was Shopping's four-month total and the actual September
 * change was +₹30,148. Returns the mis-scoped figures in `text`.
 */
export function findMisScopedFigures(
  text: string,
  payload: Record<string, unknown>,
): number[] {
  const periodFigures = collectAllowedFigures({
    wholePeriodByCategory: payload.wholePeriodByCategory,
    topMerchants: payload.topMerchants,
  });
  const latestScope: Record<string, unknown> = { ...payload };
  delete latestScope.wholePeriodByCategory;
  delete latestScope.topMerchants;
  const latestFigures = collectAllowedFigures(latestScope);
  const periodOnly = [...periodFigures].filter(
    (p) => ![...latestFigures].some((a) => Math.abs(a - p) < 0.005),
  );
  if (periodOnly.length === 0) return [];
  const bad: number[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (PERIOD_MARKER.test(sentence)) continue;
    for (const f of extractRupeeFigures(sentence)) {
      if (periodOnly.some((p) => Math.abs(p - f) < 0.005)) bad.push(f);
    }
  }
  return bad;
}

const NARRATIVE_SYSTEM =
  "You write a short, plain-English month-in-review for a personal bank statement. " +
  "Use ONLY figures from the JSON data provided — copy rupee amounts exactly as they " +
  "appear in the data; never invent, estimate, or substitute a rupee figure that is " +
  "not in the data. Mind the SCOPE of every figure: latestMonthSpendByCategory and " +
  "latestMonthTotalSpend describe the reviewed month only, while wholePeriodByCategory " +
  "and topMerchants are totals across ALL the months in the data combined — mention " +
  "those only with whole-period framing (e.g. 'across the whole period'), never as " +
  "the reviewed month's spending and never as a month-over-month increase. A " +
  "category's change versus the previous month is given only by its 'change' value " +
  "in monthOverMonthIntoLatest; call a category rising or falling only when that " +
  "change says so. Write amounts with standard Indian digit grouping (e.g. " +
  "₹1,45,000) and never regroup the digits of a figure. Write two short paragraphs, " +
  "plain and warm, no tables, no headings. Cover the biggest movements, any flagged " +
  "anomalies, and the forecast when one is present. If a category's forecast looks " +
  "inflated because the latest month contained an anomalous charge in that " +
  "category, say so — the anomaly is in the data.";

async function requestNarrative(
  payload: Record<string, unknown>,
  sterner: string | null,
  cfg: Required<GemmaOptions>,
): Promise<string> {
  const user =
    `Data:\n${JSON.stringify(payload, null, 1)}\n\n` +
    `Write the month-in-review for ${String(payload.latestMonth)}.` +
    (sterner ? `\n\n${sterner}` : "");
  let res: Response;
  try {
    res = await cfg.fetchFn(`${cfg.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        options: { temperature: 0 },
        keep_alive: 0,
        messages: [
          { role: "system", content: NARRATIVE_SYSTEM },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch {
    throw serverDown(cfg.baseUrl);
  }
  if (!res.ok) throw serverDown(cfg.baseUrl);
  const body = (await res.json()) as { message?: { content?: string } };
  return typeof body.message?.content === "string" ? body.message.content.trim() : "";
}

/** Deterministic fallback summary — built only from the aggregates. */
export function templatedNarrative(input: NarrativeInput): string {
  const { aggregates: aggs, anomalies, forecast, forecastNote } = input;
  const latestMonth = aggs.months[aggs.months.length - 1];
  const latest = aggs.monthlyTotals.filter((t) => t.month === latestMonth);
  const spendRows = latest
    .filter((t) => t.category !== "Income")
    .sort((a, b) => b.total - a.total);
  const totalSpend = spendRows.reduce((s, t) => s + t.total, 0);
  const income = input.latestMonthIncome;
  const parts: string[] = [];
  parts.push(
    `In ${latestMonth} you spent ${fmtINR(totalSpend)} across ${spendRows.length} categories` +
      (income > 0 ? ` and received ${fmtINR(income)} in income.` : "."),
  );
  if (spendRows.length > 0) {
    const top = spendRows[0];
    const delta = aggs.deltas.find(
      (d) => d.month === latestMonth && d.category === top.category,
    );
    const deltaText =
      delta && delta.delta !== 0
        ? ` (${delta.delta > 0 ? "up" : "down"} ${fmtINR(Math.abs(delta.delta))} from ${delta.prevMonth})`
        : "";
    parts.push(`The largest category was ${top.category} at ${fmtINR(top.total)}${deltaText}.`);
  }
  if (anomalies.length > 0) {
    const a = anomalies[0];
    parts.push(
      `${anomalies.length === 1 ? "One charge stands out" : `${anomalies.length} charges stand out`}: ` +
        `${a.reason} (${a.date}).`,
    );
  }
  if (forecast) {
    const top3 = Object.entries(forecast)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([c, v]) => `${c} ~${fmtINR(Math.round(v))}`)
      .join(", ");
    parts.push(`Next month's forecast (the model's raw output, unadjusted): ${top3}.`);
  } else if (forecastNote) {
    parts.push(`No forecast this run: ${forecastNote}`);
  }
  return parts.join(" ");
}

/**
 * Generate the month-in-review with grounding enforcement (DESIGN
 * §7): Gemma draft -> figure check -> one sterner retry -> templated
 * fallback. Throws OllamaUnavailable when Ollama itself cannot serve
 * (SPEC failure mode: exact fix commands, fatal at the CLI).
 */
export async function generateNarrative(
  input: NarrativeInput,
  opts: GemmaOptions = {},
): Promise<NarrativeResult> {
  const cfg = resolveOptions(opts);
  await preflightGemma(opts);
  const payload = buildNarrativePayload(input);
  const allowed = collectAllowedFigures(payload);

  let requests = 0;
  let sterner: string | null = null;
  const invented: number[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    requests++;
    const text = await requestNarrative(payload, sterner, cfg);
    // Grounding is three checks, not one (DESIGN §7 + S13 findings):
    // the figure must exist in the data, be written in well-formed
    // digit grouping, and be used in its proper scope (a whole-period
    // total must not pose as a month's amount or a monthly change).
    const bad =
      text === ""
        ? [Number.NaN]
        : [
            ...new Set([
              ...figuresAreGrounded(text, allowed),
              ...findMisScopedFigures(text, payload),
              ...malformedFigures(text),
            ]),
          ];
    if (text !== "" && bad.length === 0) {
      return { text, source: "gemma", attempts: attempt, inventedFigures: invented, requests };
    }
    const badFigures = bad.filter((f) => Number.isFinite(f));
    invented.push(...badFigures);
    sterner =
      "Your previous draft used rupee figures that failed the grounding check" +
      (badFigures.length > 0
        ? `: ${badFigures.map((f) => fmtINR(f)).join(", ")}`
        : "") +
      ". Rewrite it using ONLY figures copied exactly from the JSON data, each in " +
      "its correct scope: whole-period totals (wholePeriodByCategory, topMerchants) " +
      "cover all months combined — present them only as period totals ('across " +
      "the whole period'), never as the reviewed month's amount or as a monthly " +
      "increase; a category's monthly change is its 'change' value in " +
      "monthOverMonthIntoLatest. Keep standard digit grouping (e.g. ₹1,45,000); " +
      "do not regroup digits.";
  }
  return {
    text: templatedNarrative(input),
    source: "template",
    attempts: 2,
    inventedFigures: invented,
    requests,
  };
}
