// Shared number formatting (DESIGN §3/§7): Indian digit grouping
// everywhere a rupee figure is printed, so the report, the reason
// strings, and the narrative grounding check all speak the same
// language ("₹1,45,000", not "₹145,000").

const inr = (n: number): string =>
  n.toLocaleString("en-IN", {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  });

/** 32999 -> "₹32,999"; 1938.5 -> "₹1,938.50". */
export function fmtINR(n: number): string {
  return `₹${inr(n)}`;
}

/** Ratio display for reason strings: 17.02 -> "17", 2.63 -> "2.6". */
export function fmtRatio(r: number): string {
  if (!Number.isFinite(r)) return "many";
  if (r >= 9.95) return String(Math.round(r));
  return String(Math.round(r * 10) / 10);
}
