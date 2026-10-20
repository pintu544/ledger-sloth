import { describe, it, expect } from "vitest";
import { aggregate } from "../src/aggregate.js";
import {
  buildNarrativePayload,
  collectAllowedFigures,
  extractRupeeFigures,
  generateNarrative,
  templatedNarrative,
  type NarrativeInput,
} from "../src/categorize/gemma.js";
import { OllamaUnavailable, type Anomaly, type CategorizedTxn } from "../src/types.js";

// Two months of a tiny statement: Jun + Jul 2026.
const txns: CategorizedTxn[] = [
  { id: 1, date: "2026-06-01", description: "NEFT-SALARY", amount: 145000, category: "Income", source: "rule" },
  { id: 2, date: "2026-06-05", description: "UPI-BIGBASKET", amount: -12000, category: "Groceries", source: "rule" },
  { id: 3, date: "2026-07-01", description: "NEFT-SALARY", amount: 145000, category: "Income", source: "rule" },
  { id: 4, date: "2026-07-05", description: "UPI-BIGBASKET", amount: -12600, category: "Groceries", source: "rule" },
  { id: 5, date: "2026-07-09", description: "POS-CROMA VASHI", amount: -32999, category: "Shopping", source: "rule" },
];
const aggs = aggregate(txns);

const anomaly: Anomaly = {
  id: 5,
  date: "2026-07-09",
  description: "POS-CROMA VASHI",
  category: "Shopping",
  amount: 32999,
  expected: 1938.5,
  ratio: 17.02,
  gap: 31060.5,
  reason: "₹32,999 at CROMA — about 17× the ~₹1,939 expected for Shopping from its history",
};

const input: NarrativeInput = {
  aggregates: aggs,
  latestMonthIncome: 145000,
  anomalies: [anomaly],
  forecast: { Groceries: 13150, Shopping: 82866 },
  forecastNote: null,
  benchmark: { heldOutMonth: "2026-07", tabpfnMae: 2700.5, naiveMae: 2900.25, winner: "TabPFN" },
};

interface ChatCall {
  body: { keep_alive?: unknown; messages: Array<{ role: string; content: string }> };
}

/** A fake Ollama with a scripted /api/chat, same pattern as gemma.test.ts. */
function fakeOllama(chatScript: Array<string | Error>, models = ["gemma3:4b"]) {
  const chatCalls: ChatCall[] = [];
  let chatIndex = 0;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: models.map((name) => ({ name })) }), { status: 200 });
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

describe("extractRupeeFigures", () => {
  it("parses Indian-grouped and decimal figures; ignores bare numbers", () => {
    expect(extractRupeeFigures("spent ₹1,45,000 and ₹649.50, 3 times")).toEqual([145000, 649.5]);
    expect(extractRupeeFigures("no figures at all")).toEqual([]);
  });
});

describe("grounding discipline (DESIGN §7)", () => {
  it("a clean draft passes first try; narrative request unloads the model (keep_alive 0)", async () => {
    const clean =
      "July was steady: you spent ₹12,600 on Groceries and received ₹1,45,000 in income. " +
      "One charge stands out — ₹32,999 at CROMA, far above the ~₹1,939 expected for Shopping.";
    const { fetchFn, chatCalls } = fakeOllama([clean]);
    const result = await generateNarrative(input, { fetchFn });
    expect(result.source).toBe("gemma");
    expect(result.attempts).toBe(1);
    expect(result.text).toBe(clean);
    expect(result.inventedFigures).toEqual([]);
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0].body.keep_alive).toBe(0);
  });

  it("the prompt contains ONLY the aggregates payload (no raw narrations beyond anomalies)", async () => {
    const { fetchFn, chatCalls } = fakeOllama(["You spent ₹12,600 on Groceries."]);
    await generateNarrative(input, { fetchFn });
    const userMsg = chatCalls[0].body.messages[1].content;
    expect(userMsg).toContain('"latestMonthSpendByCategory"');
    expect(userMsg).toContain("82866"); // forecast present, raw
    expect(userMsg).not.toContain("NEFT-SALARY"); // raw statement rows stay out
  });

  it("an invented figure triggers the sterner retry; a grounded retry wins", async () => {
    const invented = "You spent ₹9,99,999 this month, mostly on Groceries at ₹12,600.";
    const clean = "You spent ₹12,600 on Groceries in July.";
    const { fetchFn, chatCalls } = fakeOllama([invented, clean]);
    const result = await generateNarrative(input, { fetchFn });
    expect(result.source).toBe("gemma");
    expect(result.attempts).toBe(2);
    expect(result.inventedFigures).toContain(999999);
    expect(chatCalls[1].body.messages[1].content).toContain("failed the grounding check");
  });

  it("a whole-period total posed as a monthly increase is rejected (S13 scope check)", async () => {
    // Groceries' whole-period total is ₹24,600 (12,000 + 12,600); the
    // reviewed month's figure is ₹12,600 and its change is +₹600.
    const misScoped = "Groceries saw a significant increase of ₹24,600 this month.";
    const clean = "You spent ₹12,600 on Groceries in July, up ₹600 from June.";
    const { fetchFn, chatCalls } = fakeOllama([misScoped, clean]);
    const result = await generateNarrative(input, { fetchFn });
    expect(result.source).toBe("gemma");
    expect(result.attempts).toBe(2);
    expect(result.inventedFigures).toContain(24600);
    expect(chatCalls[1].body.messages[1].content).toContain("whole-period");
  });

  it("a whole-period total framed as a period total is accepted first try", async () => {
    const framed = "Across the whole period, Groceries totalled ₹24,600 over the two months.";
    const { fetchFn } = fakeOllama([framed]);
    const result = await generateNarrative(input, { fetchFn });
    expect(result.source).toBe("gemma");
    expect(result.attempts).toBe(1);
    expect(result.inventedFigures).toEqual([]);
  });

  it("two mis-scoped drafts fall back to the templated summary", async () => {
    const misScoped = "Groceries saw a significant increase of ₹24,600 this month.";
    const { fetchFn } = fakeOllama([misScoped, misScoped]);
    const result = await generateNarrative(input, { fetchFn });
    expect(result.source).toBe("template");
    expect(result.attempts).toBe(2);
    expect(result.inventedFigures).toContain(24600);
  });

  it("a malformed digit grouping is rejected even when the value exists (S13)", async () => {
    // Latest-month total spend is 45,599; "₹455,99" has that value but
    // neither Indian nor international grouping — unreadable as written.
    const malformed = "Your total spending came to ₹455,99 in July.";
    const clean = "Your total spending came to ₹45,599 in July.";
    const { fetchFn } = fakeOllama([malformed, clean]);
    const result = await generateNarrative(input, { fetchFn });
    expect(result.source).toBe("gemma");
    expect(result.attempts).toBe(2);
    expect(result.inventedFigures).toContain(45599);
  });

  it("two ungrounded drafts fall back to the templated summary, noted in the result", async () => {
    const invented = "You spent ₹9,99,999 this month.";
    const { fetchFn } = fakeOllama([invented, invented]);
    const result = await generateNarrative(input, { fetchFn });
    expect(result.source).toBe("template");
    expect(result.attempts).toBe(2);
    expect(result.text).not.toContain("9,99,999");
    // The template itself must be grounded: every ₹ figure traceable.
    const allowed = collectAllowedFigures(buildNarrativePayload(input));
    for (const f of extractRupeeFigures(result.text)) {
      expect([...allowed].some((a) => Math.abs(a - f) < 0.005)).toBe(true);
    }
    expect(result.text).toContain("₹32,999"); // anomaly still reported, from aggregates
  });

  it("server down -> OllamaUnavailable with the fix command (SPEC failure mode)", async () => {
    const fetchFn = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    await expect(generateNarrative(input, { fetchFn })).rejects.toBeInstanceOf(OllamaUnavailable);
    await expect(generateNarrative(input, { fetchFn })).rejects.toThrow(/ollama serve/);
  });
});

describe("templatedNarrative", () => {
  it("names the forecast as the model's raw output, unadjusted (parent instruction)", () => {
    const text = templatedNarrative(input);
    expect(text).toContain("raw output, unadjusted");
    expect(text).toContain("₹82,866");
  });

  it("carries the forecast note when there is no forecast", () => {
    const text = templatedNarrative({
      ...input,
      forecast: null,
      forecastNote: "TabPFN unavailable because the checkpoint is missing",
    });
    expect(text).toContain("unavailable because the checkpoint is missing");
  });
});
