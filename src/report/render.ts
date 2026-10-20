// Report assembly (SPEC FR-5..FR-11, DESIGN §7): every section of
// the SPEC appears exactly once, including the degradation branches
// — an unavailable TabPFN and a short history are rendered as
// explicit notes, never as missing sections or fabricated numbers.

import { CATEGORIES } from "../categorize/categories.js";
import { fmtINR } from "../format.js";
import type { NarrativeResult } from "../categorize/gemma.js";
import type {
  Aggregates,
  BenchmarkVerdict,
  ForecastOutcome,
  RunMetrics,
} from "../types.js";

export interface ReportData {
  statementName: string;
  narrative: NarrativeResult;
  aggregates: Aggregates;
  latestMonthIncome: number;
  outcome: ForecastOutcome;
  metrics: RunMetrics;
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-09" -> "Sep 2026". */
export function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** The month after "2026-09" is "2026-10"; after "2026-12", "2027-01". */
export function nextMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

const signedINR = (n: number): string => (n < 0 ? `−${fmtINR(-n)}` : fmtINR(n));

function spendingSection(aggs: Aggregates): string[] {
  const totalIn = aggs.byCategory.reduce((s, c) => s + c.credits, 0);
  const totalOut = aggs.byCategory.reduce((s, c) => s + c.debits, 0);
  const spendByMonth = new Map<string, number>();
  for (const t of aggs.monthlyTotals) {
    if (t.category !== "Income") spendByMonth.set(`${t.month}|${t.category}`, t.total);
  }
  const spendCats = aggs.byCategory
    .filter((c) => c.category !== "Income" && c.debits > 0)
    .sort((a, b) => b.debits - a.debits);
  const lines: string[] = [
    "## Spending by category",
    "",
    `Money in: ${fmtINR(totalIn)} · Money out: ${fmtINR(totalOut)} · Net: ${signedINR(totalIn - totalOut)}`,
    "",
    `| Category | ${aggs.months.map(monthLabel).join(" | ")} | Total | Transactions |`,
    `| --- | ${aggs.months.map(() => "---").join(" | ")} | --- | --- |`,
  ];
  for (const c of spendCats) {
    const cells = aggs.months.map((m) => fmtINR(spendByMonth.get(`${m}|${c.category}`) ?? 0));
    lines.push(`| ${c.category} | ${cells.join(" | ")} | ${fmtINR(c.debits)} | ${c.count} |`);
  }
  return lines;
}

function forecastSection(data: ReportData): string[] {
  const { outcome, aggregates: aggs } = data;
  const latest = aggs.months[aggs.months.length - 1];
  const target = monthLabel(nextMonth(latest));
  const lines: string[] = [`## Forecast — next month (${target})`, ""];

  if (outcome.kind === "unavailable") {
    lines.push(
      `Forecast unavailable because ${outcome.reason}. No numbers are shown ` +
        `rather than invented ones.`,
    );
    return lines;
  }
  if (outcome.kind === "insufficient-history") {
    lines.push(
      `No forecast: this statement covers a single month, and at least two months ` +
        `of history are needed to forecast the next. Nothing is extrapolated from ` +
        `one month.`,
    );
    return lines;
  }

  lines.push(
    `TabPFN (one pooled regressor over all categories, TabPFN-3.5) trained on ` +
      `${aggs.months.map(monthLabel).join(" – ")} monthly totals. These are the ` +
      `model's raw outputs, shown unadjusted. Income is not forecast — a salary ` +
      `is not a spend prediction.`,
    "",
  );
  const rows = Object.entries(outcome.forecast).sort((a, b) => b[1] - a[1]);
  lines.push("| Category | Forecast |", "| --- | --- |");
  for (const [category, value] of rows) {
    lines.push(`| ${category} | ${fmtINR(Math.round(value * 100) / 100)} |`);
  }
  const noHistory = CATEGORIES.filter(
    (c) => c !== "Income" && !(c in outcome.forecast),
  );
  if (noHistory.length > 0) {
    lines.push("", `No history — no forecast: ${noHistory.join(", ")}.`);
  }
  const latestAnomalies = outcome.anomalies.filter((a) => a.date.startsWith(latest));
  if (latestAnomalies.length > 0) {
    const largest = latestAnomalies.reduce((a, b) => (b.amount > a.amount ? b : a));
    lines.push(
      "",
      `_Note: ${monthLabel(latest)} contained ${latestAnomalies.length} flagged ` +
        `anomalous charge${latestAnomalies.length === 1 ? "" : "s"} (largest: ` +
        `${fmtINR(largest.amount)} at ${largest.description} on ${largest.date}). ` +
        `The forecasts above are trained on that history as-is._`,
    );
  }
  if (outcome.verdict === null) {
    lines.push(
      "",
      `Forecast check: a benchmark needs three months of history (two to train, ` +
        `one to hold out) — this statement has ${aggs.months.length}, so no verdict ` +
        `is claimed.`,
    );
  }
  return lines;
}

function verdictSection(verdict: BenchmarkVerdict): string[] {
  const lines: string[] = [
    `## Forecast check — held-out ${monthLabel(verdict.heldOutMonth)} (FR-9)`,
    "",
    `Before trusting the forecast above, the same model was scored on ` +
      `${monthLabel(verdict.heldOutMonth)} — a month it was not trained on — ` +
      `against the naive baseline "next month = last month". Both errors are ` +
      `printed, win or lose.`,
    "",
    "| Category | TabPFN | Naive | Actual | TabPFN error | Naive error |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of verdict.perCategory) {
    lines.push(
      `| ${r.category} | ${fmtINR(r.tabpfnPrediction)} | ${fmtINR(r.naivePrediction)} | ` +
        `${fmtINR(r.actual)} | ${fmtINR(r.tabpfnError)} | ${fmtINR(r.naiveError)} |`,
    );
  }
  const verdictLine =
    verdict.winner === "tie"
      ? `**Verdict: a tie** — TabPFN MAE ${fmtINR(verdict.tabpfnMae)} vs naive MAE ${fmtINR(verdict.naiveMae)}.`
      : verdict.winner === "TabPFN"
        ? `**Verdict: TabPFN won** — MAE ${fmtINR(verdict.tabpfnMae)} vs naive MAE ${fmtINR(verdict.naiveMae)}.`
        : `**Verdict: the naive baseline won** — naive MAE ${fmtINR(verdict.naiveMae)} vs TabPFN MAE ${fmtINR(verdict.tabpfnMae)}. On this statement, last month repeated was the better forecast.`;
  lines.push(
    "",
    verdictLine,
    "",
    `_One held-out month, ${verdict.perCategory.length} categories — a small ` +
      `sample. This verdict describes this statement's benchmark, not TabPFN in general._`,
  );
  return lines;
}

function anomalySection(data: ReportData): string[] {
  const { outcome } = data;
  const lines: string[] = ["## Anomalies", ""];
  if (outcome.kind === "unavailable") {
    lines.push(
      `Anomaly detection unavailable because ${outcome.reason}. No charges are ` +
        `flagged rather than guessed at.`,
    );
    return lines;
  }
  if (outcome.anomalies.length === 0) {
    lines.push(
      "No charges crossed the flag thresholds (more than 2.5× the expected amount " +
        "and more than ₹1,000 above it).",
    );
    return lines;
  }
  lines.push(
    "Charges whose actual amount is far above what TabPFN expected from their " +
      "history (expected amounts are out-of-fold predictions — a charge is never " +
      "scored by a model that saw it):",
    "",
  );
  for (const a of outcome.anomalies) {
    lines.push(`- **${a.date} — ${a.description}**: ${a.reason}`);
  }
  return lines;
}

function metricsSection(m: RunMetrics): string[] {
  const s = m.stageSeconds;
  const fit =
    m.tabpfnFitSeconds && Object.keys(m.tabpfnFitSeconds).length > 0
      ? ` (fits: ${Object.entries(m.tabpfnFitSeconds)
          .map(([k, v]) => `${k} ${v.toFixed(1)}s`)
          .join(", ")})`
      : "";
  const models =
    `gemma3:4b via Ollama${m.ollamaVersion ? ` ${m.ollamaVersion}` : ""} · ` +
    (m.tabpfnVersion
      ? `tabpfn ${m.tabpfnVersion}${m.checkpoint ? ` · checkpoint ${m.checkpoint} (${m.checkpointMb ?? "?"} MB)` : ""}`
      : "TabPFN not run (see forecast section)") +
    (m.pythonEnvMb !== null ? ` · Python env ${m.pythonEnvMb} MB` : "");
  const narrativeLine =
    m.narrativeSource === "template"
      ? `templated summary substituted — both Gemma drafts used figures outside the data` +
        (m.narrativeInventedFigures.length > 0
          ? ` (${m.narrativeInventedFigures.map(fmtINR).join(", ")})`
          : "")
      : m.narrativeAttempts > 1
        ? `Gemma draft, grounded on attempt ${m.narrativeAttempts}` +
          (m.narrativeInventedFigures.length > 0
            ? ` (first draft invented ${m.narrativeInventedFigures.map(fmtINR).join(", ")})`
            : "")
        : "Gemma draft, grounded on the first attempt";
  const lines: string[] = [
    "## Run metrics",
    "",
    `- Rows parsed: ${m.rowsParsed} · excluded as non-transactions: ${m.rowsExcluded}`,
    `- Stage seconds — parse ${s.parse.toFixed(2)} · rules+memory ${s.rulesMemory.toFixed(2)} · ` +
      `Gemma categorize ${s.gemmaCategorize.toFixed(2)} (${m.gemmaRequests} requests) · ` +
      `aggregate ${s.aggregate.toFixed(2)} · TabPFN ${s.tabpfn.toFixed(2)}${fit} · ` +
      `narrative ${s.narrative.toFixed(2)} · render ${s.render.toFixed(2)} · **total ${s.total.toFixed(2)}**`,
    `- Categorization sources — memory ${m.sourceCounts.memory} · rule ${m.sourceCounts.rule} · ` +
      `Gemma ${m.sourceCounts.gemma} · Other fallback ${m.sourceCounts.other}`,
    `- Models — ${models}`,
    `- Host — ${m.hostLine}`,
    `- Narrative — ${narrativeLine}`,
  ];
  if (m.accuracyPct !== null) {
    lines.push(`- Categorization accuracy vs ground truth: ${m.accuracyPct.toFixed(1)}%`);
  }
  if (m.verdict) {
    lines.push(
      `- FR-9 verdict (held-out ${monthLabel(m.verdict.heldOutMonth)}): TabPFN MAE ` +
        `${fmtINR(m.verdict.tabpfnMae)} vs naive MAE ${fmtINR(m.verdict.naiveMae)} — ` +
        `${m.verdict.winner === "tie" ? "tie" : m.verdict.winner === "TabPFN" ? "TabPFN won" : "naive won"}`,
    );
  }
  return lines;
}

export function renderReport(data: ReportData): string {
  const { aggregates: aggs, narrative } = data;
  const first = aggs.months[0];
  const latest = aggs.months[aggs.months.length - 1];
  const lines: string[] = [
    "# Ledger Sloth — statement review",
    "",
    `Statement: ${data.statementName} · ${monthLabel(first)} – ${monthLabel(latest)} ` +
      `(${aggs.months.length} month${aggs.months.length === 1 ? "" : "s"}) · ` +
      `${data.metrics.rowsParsed} transactions`,
    "",
    `## Month in review — ${monthLabel(latest)}`,
    "",
    narrative.text,
  ];
  if (narrative.source === "template") {
    lines.push(
      "",
      "_This summary is a deterministic template: the model's drafts used figures " +
        "outside the computed data, so they were replaced rather than printed._",
    );
  }
  lines.push("", ...spendingSection(aggs), "", ...forecastSection(data));
  const verdict =
    data.outcome.kind === "ok" ? data.outcome.verdict : null;
  if (verdict) lines.push("", ...verdictSection(verdict));
  lines.push("", ...anomalySection(data), "", ...metricsSection(data.metrics));
  return lines.join("\n") + "\n";
}
