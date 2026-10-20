import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStatement } from "../src/parse/normalize.js";
import { categorizeDeterministic } from "../src/categorize/categorize.js";
import { aggregate, median, mad } from "../src/aggregate.js";
import { renderCategorizedCsv, CSV_COLUMNS } from "../src/report/csvOut.js";
import type { CategorizedTxn } from "../src/types.js";

const { txns } = parseStatement(readFileSync("fixtures/statement.csv", "utf8"));
const { categorized } = categorizeDeterministic(txns, []);
const june = categorized.filter((t) => t.date.startsWith("2026-06"));

const byCat = (aggs: ReturnType<typeof aggregate>, category: string) =>
  aggs.byCategory.find((c) => c.category === category);

describe("median / MAD helpers (hand-computed)", () => {
  it("median of odd and even inputs", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("MAD around a known center", () => {
    // values 100,110,90,1000 -> center 105 -> deviations 5,5,15,895 -> MAD 10
    expect(mad([100, 110, 90, 1000], 105)).toBe(10);
    expect(mad([], 5)).toBe(0);
  });
});

describe("aggregates — June 2026 fixture month (literal hand-computed values)", () => {
  const aggs = aggregate(june);

  it("sees exactly one month", () => {
    expect(aggs.months).toEqual(["2026-06"]);
    expect(aggs.deltas).toEqual([]);
  });

  it("Food & Dining: 29 rows, 14,788.00 out, median 525, MAD 90", () => {
    expect(byCat(aggs, "Food & Dining")).toMatchObject({
      count: 29,
      credits: 0,
      debits: 14788,
      net: -14788,
      medianDebit: 525,
      madDebit: 90,
    });
  });

  it("Transport: 15 rows, 3,969.00 out, median 275, MAD 47", () => {
    expect(byCat(aggs, "Transport")).toMatchObject({
      count: 15,
      debits: 3969,
      medianDebit: 275,
      madDebit: 47,
    });
  });

  it("Income: salary + interest credits only — 145,412.00 in, no debits", () => {
    expect(byCat(aggs, "Income")).toMatchObject({
      count: 2,
      credits: 145412,
      debits: 0,
      net: 145412,
      medianDebit: 0,
      madDebit: 0,
    });
  });

  it("Transfers mixes an incoming P2P credit with outflows", () => {
    expect(byCat(aggs, "Transfers")).toMatchObject({
      count: 3,
      credits: 1500,
      debits: 7000,
      net: -5500,
      medianDebit: 3500,
      madDebit: 1500,
    });
  });

  it("Utilities & Bills: 2 rows, 1,479.00 out, median 739.5, MAD 500.5", () => {
    expect(byCat(aggs, "Utilities & Bills")).toMatchObject({
      count: 2,
      debits: 1479,
      medianDebit: 739.5,
      madDebit: 500.5,
    });
  });

  it("monthlyTotals carries the worker's shape for the month", () => {
    expect(aggs.monthlyTotals).toContainEqual({
      month: "2026-06",
      category: "Food & Dining",
      total: 14788,
      count: 29,
    });
    const sum = aggs.monthlyTotals.reduce((s, m) => s + m.count, 0);
    expect(sum).toBe(june.length);
  });
});

describe("aggregates — full fixture (MoM deltas, top merchants)", () => {
  const aggs = aggregate(categorized);

  it("spans Jun–Sep 2026", () => {
    expect(aggs.months).toEqual(["2026-06", "2026-07", "2026-08", "2026-09"]);
  });

  it("Food & Dining Jul vs Jun: +76.00 (+0.51%)", () => {
    const d = aggs.deltas.find((x) => x.category === "Food & Dining" && x.month === "2026-07");
    expect(d).toMatchObject({ prevMonth: "2026-06", delta: 76, pct: 0.0051 });
  });

  it("top merchant is the rent payee; Swiggy is the biggest brand", () => {
    expect(aggs.topMerchants[0]).toEqual({ merchantKey: "sunrise", count: 4, debits: 112000 });
    expect(aggs.topMerchants).toContainEqual({ merchantKey: "swiggy", count: 60, debits: 33206 });
    expect(aggs.topMerchants).toHaveLength(10);
  });
});

describe("categorized CSV writer", () => {
  const sample: CategorizedTxn[] = [
    {
      id: 1,
      date: "2026-06-01",
      description: "NEFT-HELIXWORKS TECHNOLOGIES PVT LTD-SALARY",
      amount: 145000,
      category: "Income",
      source: "rule",
    },
    {
      id: 2,
      date: "2026-06-03",
      description: "UPI-METRO CARD RECHARGE, DELHI METRO",
      amount: -200,
      category: "Transport",
      source: "rule",
    },
    {
      id: 3,
      date: "2026-06-04",
      description: 'UPI-ODD "QUOTED" SHOP',
      amount: -99.5,
      category: "Shopping",
      source: "gemma",
    },
  ];

  it("renders the exact expected bytes (quoting, signs, trailing newline)", () => {
    const expected =
      "id,date,description,amount,category,source\n" +
      "1,2026-06-01,NEFT-HELIXWORKS TECHNOLOGIES PVT LTD-SALARY,145000.00,Income,rule\n" +
      '2,2026-06-03,"UPI-METRO CARD RECHARGE, DELHI METRO",-200.00,Transport,rule\n' +
      '3,2026-06-04,"UPI-ODD ""QUOTED"" SHOP",-99.50,Shopping,gemma\n';
    expect(renderCategorizedCsv(sample)).toBe(expected);
    expect(CSV_COLUMNS.join(",")).toBe("id,date,description,amount,category,source");
  });

  it("two runs over the fixture produce byte-identical output", () => {
    const first = renderCategorizedCsv(categorized);
    const second = renderCategorizedCsv(categorizeDeterministic(txns, []).categorized);
    expect(second).toBe(first);
    expect(first.split("\n")).toHaveLength(251); // header + 249 rows + trailing ""
    expect(first.startsWith("id,date,description,amount,category,source\n")).toBe(true);
  });

  it("rows stay in input order", () => {
    const ids = renderCategorizedCsv(categorized)
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => Number(line.split(",")[0]));
    expect(ids).toEqual(categorized.map((t) => t.id));
  });
});
