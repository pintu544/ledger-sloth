// Correction memory (SPEC FR-4, DESIGN §4): a human-editable JSON file
// of {pattern, category} entries. A user's correction beats the
// deterministic rules and the model — the same merchant pattern is
// categorized the user's way on every later run, with no retraining.
//
// Lookup is by normalized merchant key: merchantKey("POS-CROMA VASHI")
// is "croma" (the DESIGN §2 worker protocol uses the same key).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isCategory } from "./categories.js";
import type { Category, Txn } from "../types.js";

export interface MemoryEntry {
  pattern: string;
  category: Category;
}

const CHANNEL_HEADS: ReadonlySet<string> = new Set([
  "UPI",
  "ACH",
  "ACH D",
  "NEFT",
  "IMPS",
  "POS",
  "BBPS",
  "ATM WDL",
  "ATM",
  "ECOM",
  "PUR",
  "NFS",
]);

const STOPWORDS: ReadonlySet<string> = new Set([
  "INDIA",
  "PVT",
  "LTD",
  "LIMITED",
  "INC",
  "COM",
  "CO",
  "THE",
]);

/**
 * Normalize a narration (or a user-supplied pattern) to its merchant
 * key: drop the channel prefix (UPI-, ACH D-, NEFT-, POS-, …), then
 * take the first significant token, lowercased.
 * "UPI-SWIGGY-BANGALORE" -> "swiggy" · "ACH D- NETFLIX COM" -> "netflix"
 * · "POS-CROMA VASHI" -> "croma" · "SWIGGY" -> "swiggy".
 */
export function merchantKey(text: string): string {
  let s = text.toUpperCase().trim();
  // Strip a leading channel head, which may itself contain a space
  // ("ACH D- NETFLIX COM", "ATM WDL-HDFC BANK VASHI ATM").
  for (const head of CHANNEL_HEADS) {
    if (s.startsWith(head + "-") || s.startsWith(head + " -")) {
      s = s.slice(head.length).replace(/^\s*-\s*/, "");
      break;
    }
  }
  const tokens = s.split(/[^A-Z0-9]+/).filter((t) => t !== "");
  for (const token of tokens) {
    if (!STOPWORDS.has(token)) return token.toLowerCase();
  }
  return tokens[0]?.toLowerCase() ?? "";
}

/** Category for a txn from memory, or null. First matching entry wins. */
export function applyMemory(txn: Txn, entries: readonly MemoryEntry[]): Category | null {
  if (entries.length === 0) return null;
  const key = merchantKey(txn.description);
  if (key === "") return null;
  for (const entry of entries) {
    if (merchantKey(entry.pattern) === key) return entry.category;
  }
  return null;
}

export function loadMemory(path: string): MemoryEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Correction memory file "${path}" is not valid JSON. Fix it by hand ` +
        `(it is a JSON array of {"pattern": "...", "category": "..."} entries) or delete it to start fresh.`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Correction memory file "${path}" must be a JSON array of entries.`);
  }
  const entries: MemoryEntry[] = [];
  for (const item of parsed) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as { pattern?: unknown }).pattern === "string" &&
      isCategory((item as { category?: unknown }).category)
    ) {
      const e = item as MemoryEntry;
      entries.push({ pattern: e.pattern, category: e.category });
    } else {
      throw new Error(
        `Correction memory file "${path}" has an entry that is not {"pattern": string, "category": <fixed category>}: ` +
          JSON.stringify(item),
      );
    }
  }
  return entries;
}

export function saveMemory(path: string, entries: readonly MemoryEntry[]): void {
  writeFileSync(path, JSON.stringify(entries, null, 2) + "\n", "utf8");
}

/**
 * Record a user correction: an existing entry with the same merchant
 * key is replaced (the newest correction wins), otherwise the entry is
 * appended. Returns the full updated entry list.
 */
export function addCorrection(path: string, pattern: string, category: Category): MemoryEntry[] {
  const key = merchantKey(pattern);
  const entries = loadMemory(path).filter((e) => merchantKey(e.pattern) !== key);
  entries.push({ pattern, category });
  saveMemory(path, entries);
  return entries;
}
