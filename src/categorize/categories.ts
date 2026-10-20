// The fixed category list — single source of truth (DESIGN §4).
// SPEC FR-3: every transaction ends with exactly one of these.

import type { Category } from "../types.js";

export const CATEGORIES: readonly Category[] = [
  "Income",
  "Rent & Housing",
  "Groceries",
  "Food & Dining",
  "Transport",
  "Utilities & Bills",
  "Subscriptions",
  "Shopping",
  "Health & Pharmacy",
  "Entertainment",
  "Investments",
  "Transfers",
  "Fees & Charges",
  "Other",
];

const CATEGORY_SET: ReadonlySet<string> = new Set(CATEGORIES);

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && CATEGORY_SET.has(value);
}
