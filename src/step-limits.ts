// A step's cores, memory and disk: the size class's figures (env-tunable per install) with an agent's `resources:`
// over them. Kept apart from run-container.ts so foldrun code reads what an agent asks without loading the
// container machinery (FOL-240: its module ceiling); run-container re-exports all of it.

import { platform } from "./platform.ts";
import { anyMemoryMi, quantityMi, type ResourceOverride } from "./resources.ts";

export function sizeLimits(size?: "small" | "large" | "heavy"): { cpus: string; memory: string } {
  if (size === "small") {
    return {
      cpus: platform.setting("FOLDRUN_RUNNER_CPUS_SMALL") ?? "1",
      memory: platform.setting("FOLDRUN_RUNNER_MEMORY_SMALL") ?? "1Gi",
    };
  }
  if (size === "heavy") {
    // For steps that render a browser or hold real data. The memory figure is
    // a hard ceiling (memory is not compressible — over it, the kernel OOM-kills
    // the pod, which on a single-box install can take neighbours with it). The
    // cpus figure is both the rate its seconds are priced at and, since
    // 26 Oct 2026, the cores the sandbox is capped at.
    return {
      cpus: platform.setting("FOLDRUN_RUNNER_CPUS_HEAVY") ?? "4",
      memory: platform.setting("FOLDRUN_RUNNER_MEMORY_HEAVY") ?? "8Gi",
    };
  }
  return {
    cpus: platform.setting("FOLDRUN_RUNNER_CPUS") ?? "2",
    memory: platform.setting("FOLDRUN_RUNNER_MEMORY") ?? "2g",
  };
}

/** What one step's sandbox holds: cores and memory (each a hard limit and a
 *  billing figure) and, where the agent set it, disk. */
export interface StepLimits {
  cpus: string;
  memory: string;
  /** The agent's `resources: disk`, or null for the class's (the k8s tier's
   *  diskFor; Docker has no per-container disk cap). */
  disk: string | null;
}

/**
 * The class's figures with an agent's `resources:` over them, key by key.
 *
 * `atLeastClass` is for a retry that moved the step up a class after the
 * cluster ended it for want of memory or disk: each override is raised to
 * the bigger class's figure, so `memory: 3Gi` OOM-killed at large retries at
 * heavy's 8Gi rather than the same 3Gi that already failed.
 */
export function resolveResources(
  size?: "small" | "large" | "heavy",
  override?: ResourceOverride | null,
  opts: { atLeastClass?: boolean } = {},
): StepLimits {
  const base = sizeLimits(size);
  const bigger = (mine: number, theirs: number) => (opts.atLeastClass ? Math.max(mine, theirs) : mine);
  const baseMi = anyMemoryMi(base.memory);
  let cpus = base.cpus;
  if (override?.cpu !== undefined) {
    const b = Number(base.cpus);
    cpus = String(Number.isFinite(b) ? bigger(override.cpu, b) : override.cpu);
  }
  let memory = base.memory;
  if (override?.memory !== undefined) {
    const mi = quantityMi(override.memory);
    memory = Number.isFinite(baseMi) && opts.atLeastClass && baseMi > mi ? base.memory : override.memory;
  }
  // Disk the same way: a step evicted for disk at its own `disk: 2Gi` would
  // fail again at 2Gi, whatever class the retry moved it to.
  let disk = override?.disk ?? null;
  if (disk && opts.atLeastClass) {
    const classMi = anyMemoryMi(classDisk(size));
    if (Number.isFinite(classMi) && classMi > quantityMi(disk)) disk = null;
  }
  return { cpus, memory, disk };
}

/** The node disk a class may write (the k8s `ephemeral-storage` limit;
 *  Docker has no per-container cap). Env-tunable like the cores and memory. */
export function classDisk(size?: "small" | "large" | "heavy"): string {
  if (size === "small") return process.env.FOLDRUN_RUNNER_DISK_SMALL ?? "2Gi";
  if (size === "heavy") return process.env.FOLDRUN_RUNNER_DISK_HEAVY ?? "20Gi";
  return process.env.FOLDRUN_RUNNER_DISK ?? "8Gi";
}

