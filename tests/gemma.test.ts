import { describe, it, expect } from "vitest";
import { preflightGemma, categorizeWithGemma } from "../src/categorize/gemma.js";
import { OllamaUnavailable, type Txn } from "../src/types.js";

const txn = (id: number, description: string, amount = -100): Txn => ({
  id,
  date: "2026-06-15",
  description,
  amount,
});

interface ChatCall {
  body: {
    keep_alive?: unknown;
    messages: Array<{ role: string; content: string }>;
  };
}

/** A fake Ollama: /api/tags, /api/version, and a scripted /api/chat. */
function fakeOllama(chatScript: Array<string | Error>, models = ["gemma3:4b"]) {
  const chatCalls: ChatCall[] = [];
  let chatIndex = 0;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }), {
        status: 200,
      });
    }
    if (url.endsWith("/api/version")) {
      return new Response(JSON.stringify({ version: "0.40.6" }), { status: 200 });
    }
    if (url.endsWith("/api/chat")) {
      chatCalls.push({ body: JSON.parse(String(init?.body)) as ChatCall["body"] });
      const next = chatScript[Math.min(chatIndex++, chatScript.length - 1)];
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify({ message: { content: next } }), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
  return { fetchFn, chatCalls };
}

describe("Gemma pre-flight", () => {
  it("server down -> OllamaUnavailable carrying the `ollama serve` fix", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(preflightGemma({ fetchFn })).rejects.toBeInstanceOf(OllamaUnavailable);
    await expect(preflightGemma({ fetchFn })).rejects.toThrow(/ollama serve/);
  });

  it("model missing -> OllamaUnavailable carrying the `ollama pull` fix", async () => {
    const { fetchFn } = fakeOllama([], ["llama3.2:3b"]);
    await expect(preflightGemma({ fetchFn })).rejects.toThrow(/ollama pull gemma3:4b/);
  });

  it("healthy server -> models + version", async () => {
    const { fetchFn } = fakeOllama([]);
    const pre = await preflightGemma({ fetchFn });
    expect(pre.models).toContain("gemma3:4b");
    expect(pre.version).toBe("0.40.6");
  });
});

describe("Gemma categorizer", () => {
  const rows = [
    txn(1, "UPI-SWIGGY-BANGALORE", -549),
    txn(2, "UPI-UBER INDIA-MUMBAI", -320),
    txn(3, "UPI-SOMETHING ELSE", -100),
  ];

  it("maps a valid reply positionally, one category per row", async () => {
    const { fetchFn, chatCalls } = fakeOllama(['["Food & Dining", "Transport", "Shopping"]']);
    const { categorized, metrics } = await categorizeWithGemma(rows, { fetchFn });
    expect(categorized.map((t) => [t.id, t.category, t.source])).toEqual([
      [1, "Food & Dining", "gemma"],
      [2, "Transport", "gemma"],
      [3, "Shopping", "gemma"],
    ]);
    expect(metrics).toMatchObject({ requests: 1, invalidRows: 0, failedBatches: 0 });
    expect(chatCalls).toHaveLength(1);
  });

  it("an invalid element degrades only that row to Other, and is counted", async () => {
    const { fetchFn } = fakeOllama(['["Food & Dining", "Fun Money", "Shopping"]']);
    const { categorized, metrics } = await categorizeWithGemma(rows, { fetchFn });
    expect(categorized[1]).toMatchObject({ category: "Other", source: "other" });
    expect(categorized[0].category).toBe("Food & Dining");
    expect(metrics.invalidRows).toBe(1);
    expect(metrics.sourceCounts).toEqual({ gemma: 2, other: 1 });
  });

  it("a wrong-length reply is retried once, never mapped on faith", async () => {
    const { fetchFn } = fakeOllama([
      '["Food & Dining", "Transport"]',
      '["Food & Dining", "Transport", "Shopping"]',
    ]);
    const { categorized, metrics } = await categorizeWithGemma(rows, { fetchFn });
    expect(metrics.requests).toBe(2);
    expect(metrics.failedBatches).toBe(0);
    expect(categorized.map((t) => t.category)).toEqual([
      "Food & Dining",
      "Transport",
      "Shopping",
    ]);
  });

  it("a persistently wrong-length reply degrades the whole batch to Other", async () => {
    const { fetchFn } = fakeOllama(['["Food & Dining"]']);
    const { categorized, metrics } = await categorizeWithGemma(rows, { fetchFn });
    expect(metrics.requests).toBe(2);
    expect(metrics.failedBatches).toBe(1);
    expect(categorized.every((t) => t.category === "Other" && t.source === "other")).toBe(true);
    expect(metrics.invalidRows).toBe(3);
  });

  it("a reply wrapped in prose/code fences still parses", async () => {
    const { fetchFn } = fakeOllama([
      'Here you go:\n```json\n["Food & Dining", "Transport", "Shopping"]\n```',
    ]);
    const { categorized } = await categorizeWithGemma(rows, { fetchFn });
    expect(categorized.map((t) => t.category)).toEqual([
      "Food & Dining",
      "Transport",
      "Shopping",
    ]);
  });

  it("the final request of the stage sends keep_alive: 0 (Gemma unloads for TabPFN)", async () => {
    const { fetchFn, chatCalls } = fakeOllama([
      '["Food & Dining", "Transport"]',
      '["Shopping"]',
    ]);
    await categorizeWithGemma(rows, { fetchFn, batchSize: 2 });
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[0].body.keep_alive).not.toBe(0);
    expect(chatCalls[1].body.keep_alive).toBe(0);
  });

  it("no leftovers -> no pre-flight, no requests", async () => {
    const { fetchFn, chatCalls } = fakeOllama([]);
    const { categorized, metrics } = await categorizeWithGemma([], { fetchFn });
    expect(categorized).toEqual([]);
    expect(metrics.requests).toBe(0);
    expect(chatCalls).toHaveLength(0);
  });

  it("with Ollama down, categorize fails with the exact fix commands", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(categorizeWithGemma(rows, { fetchFn })).rejects.toThrow(/ollama serve/);
  });
});
