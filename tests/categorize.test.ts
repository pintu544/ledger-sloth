import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATEGORIES, isCategory } from "../src/categorize/categories.js";
import { applyRules } from "../src/categorize/rules.js";
import {
  merchantKey,
  applyMemory,
  loadMemory,
  saveMemory,
  addCorrection,
  type MemoryEntry,
} from "../src/categorize/memory.js";
import { categorizeDeterministic } from "../src/categorize/categorize.js";
import { parseStatement } from "../src/parse/normalize.js";
import { runCorrect } from "../src/index.js";
import type { Txn } from "../src/types.js";

const txn = (description: string, amount = -100): Txn => ({
  id: 1,
  date: "2026-06-15",
  description,
  amount,
});

describe("fixed category list", () => {
  it("has the 14 DESIGN §4 categories", () => {
    expect(CATEGORIES).toHaveLength(14);
    expect(CATEGORIES).toContain("Food & Dining");
    expect(CATEGORIES).toContain("Other");
  });

  it("isCategory accepts only list members", () => {
    expect(isCategory("Groceries")).toBe(true);
    expect(isCategory("groceries")).toBe(false);
    expect(isCategory("Fun Money")).toBe(false);
    expect(isCategory(42)).toBe(false);
    expect(isCategory(null)).toBe(false);
  });
});

describe("merchant rules", () => {
  const cases: Array<[string, string]> = [
    ["NEFT-HELIXWORKS TECHNOLOGIES PVT LTD-SALARY", "Income"],
    ["CREDIT INTEREST CAPITALISED", "Income"],
    ["NEFT-SUNRISE HOUSING SOCIETY-RENT", "Rent & Housing"],
    ["ACH D- ZERODHA BROKING SIP", "Investments"],
    ["ACH D- NETFLIX COM", "Subscriptions"],
    ["ACH D- SPOTIFY INDIA", "Subscriptions"],
    ["UPI-BIGBASKET-BANGALORE", "Groceries"],
    ["UPI-SWIGGY-BANGALORE", "Food & Dining"],
    ["UPI-ZOMATO-GURGAON", "Food & Dining"],
    ["UPI-CHAI SUTTA CAFE-MUMBAI", "Food & Dining"],
    ["UPI-UBER INDIA-MUMBAI", "Transport"],
    ["UPI-RAPIDO-BANGALORE", "Transport"],
    ["UPI-METRO CARD RECHARGE, DELHI METRO", "Transport"],
    ["BBPS-MSEDCL ELECTRICITY BILL PAYMENT", "Utilities & Bills"],
    ["UPI-JIO PREPAID RECHARGE-9876543210", "Utilities & Bills"],
    ["UPI-AMAZON PAY-INDIA", "Shopping"],
    ["UPI-FLIPKART-INTERNET", "Shopping"],
    ["POS-CROMA VASHI-ELECTRONICS", "Shopping"],
    ["UPI-APOLLO PHARMACY-VASHI", "Health & Pharmacy"],
    ["UPI-BOOKMYSHOW-MUMBAI", "Entertainment"],
    ["UPI-PVR CINEMAS-MUMBAI", "Entertainment"],
    ["AMB CHG INCL GST-1234567890", "Fees & Charges"],
    ["ATM WDL-HDFC BANK VASHI ATM", "Transfers"],
    ["UPI-ROHIT SHARMA-9812345670", "Transfers"],
    ["UPI-ANITA KUMAR-9812345671", "Transfers"],
  ];
  for (const [description, category] of cases) {
    it(`${description} -> ${category}`, () => {
      expect(applyRules(txn(description))).toBe(category);
    });
  }

  it("rule order: NOTION LABS is Subscriptions, not Health (LABS)", () => {
    expect(applyRules(txn("ACH D- NOTION LABS INC"))).toBe("Subscriptions");
  });

  it("rule order: AMAZON FRESH is Groceries, not Shopping", () => {
    expect(applyRules(txn("UPI-AMAZON FRESH-INDIA"))).toBe("Groceries");
  });

  it("rule order: a recharge is never Fees (RECHARGE contains CHG)", () => {
    expect(applyRules(txn("UPI-JIO PREPAID RECHARGE-9876543210"))).toBe("Utilities & Bills");
  });

  it("an unknown merchant is a miss, not a guess", () => {
    expect(applyRules(txn("UPI-QWERTY FROBNICATOR-LONDON"))).toBeNull();
  });
});

describe("merchantKey", () => {
  const cases: Array<[string, string]> = [
    ["POS-CROMA VASHI", "croma"],
    ["POS-CROMA VASHI-ELECTRONICS", "croma"],
    ["UPI-SWIGGY-BANGALORE", "swiggy"],
    ["ACH D- NETFLIX COM", "netflix"],
    ["UPI-BIGBASKET-BANGALORE", "bigbasket"],
    ["ATM WDL-HDFC BANK VASHI ATM", "hdfc"],
    ["SWIGGY", "swiggy"],
    ["Croma", "croma"],
  ];
  for (const [input, key] of cases) {
    it(`${input} -> ${key}`, () => {
      expect(merchantKey(input)).toBe(key);
    });
  }
});

describe("correction memory", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sloth-memory-"));
    path = join(dir, "memory.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a missing file loads as empty memory", () => {
    expect(loadMemory(path)).toEqual([]);
  });

  it("save/load round-trips entries", () => {
    const entries: MemoryEntry[] = [{ pattern: "CROMA", category: "Shopping" }];
    saveMemory(path, entries);
    expect(loadMemory(path)).toEqual(entries);
  });

  it("applyMemory matches by merchant key, wherever the pattern came from", () => {
    const entries: MemoryEntry[] = [{ pattern: "UPI-CROMA VASHI", category: "Shopping" }];
    expect(applyMemory(txn("POS-CROMA VASHI-ELECTRONICS"), entries)).toBe("Shopping");
    expect(applyMemory(txn("UPI-SWIGGY-BANGALORE"), entries)).toBeNull();
  });

  it("addCorrection appends, and replaces an entry with the same merchant key", () => {
    addCorrection(path, "SWIGGY", "Food & Dining");
    addCorrection(path, "UPI-SWIGGY-BANGALORE", "Groceries");
    const entries = loadMemory(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe("Groceries");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(entries);
  });

  it("a corrupt memory file fails loudly with a fix-it message", () => {
    writeFileSync(path, "{not json");
    expect(() => loadMemory(path)).toThrow(/not valid JSON/);
  });

  it("memory beats rules in the deterministic stage (FR-4)", () => {
    const memory: MemoryEntry[] = [{ pattern: "SWIGGY", category: "Groceries" }];
    const { categorized, leftovers } = categorizeDeterministic(
      [txn("UPI-SWIGGY-BANGALORE")],
      memory,
    );
    expect(leftovers).toHaveLength(0);
    expect(categorized[0]).toMatchObject({ category: "Groceries", source: "memory" });
  });
});

describe("correct CLI subcommand", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sloth-cli-"));
    path = join(dir, "memory.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records a correction and returns 0", () => {
    expect(runCorrect(["CROMA", "Shopping", "--memory", path])).toBe(0);
    expect(loadMemory(path)).toEqual([{ pattern: "CROMA", category: "Shopping" }]);
  });

  it("rejects a category outside the fixed list", () => {
    expect(runCorrect(["CROMA", "Fun Money", "--memory", path])).toBe(2);
    expect(loadMemory(path)).toEqual([]);
  });
});

describe("S5 measurement — rules+memory over the fixture", () => {
  const { txns } = parseStatement(readFileSync("fixtures/statement.csv", "utf8"));
  const gt = JSON.parse(readFileSync("fixtures/ground-truth.json", "utf8")) as {
    rows: Array<{ id: number; category: string }>;
  };
  const expected = new Map(gt.rows.map((row) => [row.id, row.category]));

  it("coverage: every fixture row is categorized without Gemma (measured 249/249)", () => {
    const { categorized, leftovers, counts } = categorizeDeterministic(txns, []);
    expect(leftovers).toHaveLength(0);
    expect(counts).toEqual({ memory: 0, rule: 249, leftover: 0 });
    expect(categorized).toHaveLength(249);
  });

  it("accuracy: rules+memory match ground truth on all 249 rows", () => {
    const { categorized } = categorizeDeterministic(txns, []);
    const correct = categorized.filter((t) => expected.get(t.id) === t.category).length;
    expect(correct / categorized.length).toBe(1);
  });
});
