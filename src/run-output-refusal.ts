// One refused run output as a sentence a person reads (FOL-126 phase 5).
// Pure, so the run page (a client component) can use it without the store.

import type { RefusedOutput } from "./store.ts";

const mib = (n: number) => `${(n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1)} MiB`;
/** One refusal as a sentence a person reads on the run page. */
export function refusalText(r: RefusedOutput): string {
  switch (r.reason) {
    case "file-cap":
      return `${r.agent}/${r.path} (${mib(r.bytes)}) was not kept: a file may be at most ${mib(r.limit ?? 0)}`;
    case "run-cap":
      return `${r.agent}/${r.path} (${mib(r.bytes)}) was not kept: this run's outputs may total at most ${mib(r.limit ?? 0)}`;
    case "count":
      return `${r.agent}/${r.path} was not kept: a run keeps at most ${r.limit ?? 50_000} files per agent`;
    default:
      return `${r.agent}/${r.path} was not kept: its name cannot be stored (control characters, over 400 bytes, or differs from another file only by case)`;
  }
}

