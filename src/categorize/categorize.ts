// The deterministic stage of the categorize pipeline (DESIGN §1,
// stage [2]): correction memory first (the user's word beats every
// default), then the merchant rules. Whatever both miss is returned
// as leftovers for the Gemma stage (S6) — this layer never guesses.

import { applyMemory, type MemoryEntry } from "./memory.js";
import { applyRules } from "./rules.js";
import type { CategorizedTxn, Txn } from "../types.js";

export interface DeterministicResult {
  categorized: CategorizedTxn[];
  leftovers: Txn[];
  /** Source counts across the whole input: memory / rule / leftover. */
  counts: { memory: number; rule: number; leftover: number };
}

export function categorizeDeterministic(
  txns: readonly Txn[],
  memory: readonly MemoryEntry[],
): DeterministicResult {
  const categorized: CategorizedTxn[] = [];
  const leftovers: Txn[] = [];
  const counts = { memory: 0, rule: 0, leftover: 0 };

  for (const txn of txns) {
    const fromMemory = applyMemory(txn, memory);
    if (fromMemory !== null) {
      categorized.push({ ...txn, category: fromMemory, source: "memory" });
      counts.memory++;
      continue;
    }
    const fromRule = applyRules(txn);
    if (fromRule !== null) {
      categorized.push({ ...txn, category: fromRule, source: "rule" });
      counts.rule++;
      continue;
    }
    leftovers.push(txn);
    counts.leftover++;
  }
  return { categorized, leftovers, counts };
}
