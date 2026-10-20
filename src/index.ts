// Ledger Sloth CLI (DESIGN §4).
//   report <csv> [--memory <path>] [--out <dir>] [--ground-truth <path>]
//     — lands in S12; until then it explains itself and exits non-zero.
//   correct "<pattern>" <Category> [--memory <path>]
//     — SPEC FR-4: teach the local correction memory (S5).

import { addCorrection } from "./categorize/memory.js";
import { CATEGORIES, isCategory } from "./categorize/categories.js";

export const DEFAULT_MEMORY_PATH = "ledger-sloth-memory.json";

const USAGE = `Usage:
  ledger-sloth report <statement.csv> [--memory <path>] [--out <dir>] [--ground-truth <path>]
  ledger-sloth correct "<pattern>" <Category> [--memory <path>]

Categories: ${CATEGORIES.join(", ")}`;

function takeFlag(args: string[], flag: string): { value: string | null; rest: string[] } {
  const i = args.indexOf(flag);
  if (i === -1) return { value: null, rest: args };
  const value = args[i + 1];
  if (value === undefined) throw new Error(`Flag ${flag} needs a value.`);
  return { value, rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

/** Run the `correct` subcommand. Returns the process exit code. */
export function runCorrect(args: string[]): number {
  const { value: memoryPath, rest } = takeFlag(args, "--memory");
  const [pattern, categoryRaw] = rest;
  if (!pattern || !categoryRaw || rest.length > 2) {
    console.error(USAGE);
    return 2;
  }
  if (!isCategory(categoryRaw)) {
    console.error(
      `"${categoryRaw}" is not one of the fixed categories.\nCategories: ${CATEGORIES.join(", ")}`,
    );
    return 2;
  }
  const path = memoryPath ?? DEFAULT_MEMORY_PATH;
  const entries = addCorrection(path, pattern, categoryRaw);
  console.log(
    `Recorded: "${pattern}" -> ${categoryRaw} (${entries.length} correction${entries.length === 1 ? "" : "s"} in ${path}).`,
  );
  return 0;
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  switch (command) {
    case "correct":
      return runCorrect(rest);
    case "report":
      console.error("The report command lands in slice S12 — not built yet.");
      return 2;
    default:
      console.error(USAGE);
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
