import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStatement, parseAmount, parseDate } from "../src/parse/normalize.js";
import { ParseError, UnrecognizedColumns } from "../src/types.js";

interface GroundTruth {
  plantedAnomalyRowId: number;
  totalTransactions: number;
  excludedRowCount: number;
  finalBalance: number;
}

const fixture = readFileSync("fixtures/statement.csv", "utf8");
const icici = readFileSync("fixtures/statement-icici.csv", "utf8");
const gt = JSON.parse(readFileSync("fixtures/ground-truth.json", "utf8")) as GroundTruth;

describe("HDFC fixture (S3 contract)", () => {
  const { txns, excluded, layout } = parseStatement(fixture);

  it("detects the HDFC layout", () => {
    expect(layout).toBe("hdfc");
  });

  it("parses to the exact expected transaction count and exclusion count", () => {
    expect(txns.length).toBe(gt.totalTransactions);
    expect(excluded).toBe(gt.excludedRowCount);
  });

  it("assigns sequential ids in file order", () => {
    txns.forEach((t, i) => expect(t.id).toBe(i + 1));
  });

  it("reads the salary credit as the first transaction", () => {
    expect(txns[0].date).toBe("2026-06-01");
    expect(txns[0].amount).toBe(145000);
    expect(txns[0].description).toContain("SALARY");
    expect(txns[0].balance).toBeCloseTo(231420.55, 2);
  });

  it("keeps the running balance consistent through the final row", () => {
    expect(txns[txns.length - 1].balance).toBeCloseTo(gt.finalBalance, 2);
  });

  it("places the planted CROMA anomaly at the ground-truth row id", () => {
    const anomaly = txns[gt.plantedAnomalyRowId - 1];
    expect(anomaly.description).toContain("CROMA");
    expect(anomaly.amount).toBe(-32999);
    expect(anomaly.date).toBe("2026-09-14");
  });

  it("parses a quoted narration containing a comma as one field (RFC-4180)", () => {
    const metro = txns.find((t) => t.description.includes("METRO CARD"));
    expect(metro?.description).toBe("UPI-METRO CARD RECHARGE, DELHI METRO");
  });
});

describe("ICICI variant", () => {
  const { txns, excluded, layout } = parseStatement(icici);

  it("parses through the ICICI mapping", () => {
    expect(layout).toBe("icici");
    expect(txns.length).toBe(10);
    expect(excluded).toBe(0);
  });

  it("signs credits positive and debits negative", () => {
    expect(txns[0].amount).toBe(145000);
    expect(txns[1].amount).toBe(-612);
    expect(txns[0].date).toBe("2026-07-01");
  });
});

describe("other layouts", () => {
  it("parses an SBI-layout statement", () => {
    const sbi = [
      "Txn Date,Description,Debit,Credit,Balance",
      "01 Jul 2026,UPI-SWIGGY-ORDER,450.00,,10549.00",
      "02 Jul 2026,NEFT SALARY,,50000.00,60549.00",
    ].join("\n");
    const { txns, layout } = parseStatement(sbi);
    expect(layout).toBe("sbi");
    expect(txns).toHaveLength(2);
    expect(txns[0].amount).toBe(-450);
    expect(txns[1].amount).toBe(50000);
    expect(txns[0].date).toBe("2026-07-01");
  });

  it("parses a generic signed-amount statement", () => {
    const generic = [
      "Date,Description,Amount",
      "05/08/26,UPI-ZOMATO,-512.00",
      "06/08/26,SALARY CREDIT,90000.00",
    ].join("\n");
    const { txns, layout } = parseStatement(generic);
    expect(layout).toBe("signed");
    expect(txns[0].amount).toBe(-512);
    expect(txns[1].amount).toBe(90000);
  });
});

describe("SPEC failure behaviour", () => {
  it("empty input fails with a plain ParseError", () => {
    expect(() => parseStatement("")).toThrow(ParseError);
    expect(() => parseStatement("   \n  ")).toThrow(/empty/i);
  });

  it("garbage input fails listing the headers found", () => {
    let err: unknown;
    try {
      parseStatement("hello,world\nfoo,bar");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnrecognizedColumns);
    expect((err as Error).message).toContain("hello");
    expect((err as Error).message).toContain("world");
    expect((err as Error).message).toContain("HDFC");
  });

  it("headers with no transaction rows fail as a ParseError, producing nothing", () => {
    const headersOnly = "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n";
    expect(() => parseStatement(headersOnly)).toThrow(ParseError);
  });

  it("an unparseable date on a transaction row fails naming the row", () => {
    const bad = ["Date,Description,Amount", "not-a-date,UPI-SWIGGY,-100.00"].join("\n");
    expect(() => parseStatement(bad)).toThrow(/date/i);
  });
});

describe("amount and date primitives", () => {
  it("parses Indian-grouped amounts and Cr/Dr suffixes", () => {
    expect(parseAmount("1,45,000.00")).toBe(145000);
    expect(parseAmount("1,240.00 Cr")).toBe(1240);
    expect(parseAmount("240.00 Dr")).toBe(-240);
    expect(parseAmount("(500.00)")).toBe(-500);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("-")).toBeNull();
  });

  it("parses the statement date dialects", () => {
    expect(parseDate("05/06/26")).toBe("2026-06-05");
    expect(parseDate("05/06/2026")).toBe("2026-06-05");
    expect(parseDate("05-Jun-2026")).toBe("2026-06-05");
    expect(parseDate("2026-06-05")).toBe("2026-06-05");
    expect(parseDate("garbage")).toBeNull();
  });
});
