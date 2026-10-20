// Run-metrics plumbing (DESIGN §7): a stage timer plus the measured
// host/environment facts the FR-11 block reports. Everything here is
// measured at run time — CPU/RAM from the OS, sizes from the disk —
// never asserted from the spec.

import { readdirSync, statSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import path from "node:path";
import { CHECKPOINT_PATTERN } from "./tabpfn/client.js";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class StageTimer {
  private totals = new Map<string, number>();

  async time<T>(stage: string, fn: () => T | Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      const s = (performance.now() - t0) / 1000;
      this.totals.set(stage, (this.totals.get(stage) ?? 0) + s);
    }
  }

  seconds(stage: string): number {
    return round2(this.totals.get(stage) ?? 0);
  }
}

/** "2 vCPU · 7.9 GB RAM · CPU-only" — from the OS, not the brochure. */
export function hostLine(): string {
  const gb = totalmem() / 1024 ** 3;
  return `${cpus().length} vCPU · ${gb.toFixed(1)} GB RAM · CPU-only`;
}

/** Recursive size of a directory tree in bytes; null when unreadable. */
export function dirSizeBytes(root: string): number | null {
  try {
    let total = 0;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(p);
        else if (entry.isFile()) total += statSync(p).size;
      }
    }
    return total;
  } catch {
    return null;
  }
}

/** The TabPFN-3.5 checkpoint in the cache dir: name + on-disk size. */
export function checkpointInfo(cacheDir: string): { name: string; bytes: number } | null {
  try {
    const name = readdirSync(cacheDir).find((f) => CHECKPOINT_PATTERN.test(f));
    if (!name) return null;
    return { name, bytes: statSync(path.join(cacheDir, name)).size };
  } catch {
    return null;
  }
}

export const toMb = (bytes: number | null): number | null =>
  bytes === null ? null : Math.round((bytes / 1024 ** 2) * 10) / 10;
