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
import { OllamaUnavailable, type CategorizedTxn, type Category, type Txn } from "../types.js";

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
