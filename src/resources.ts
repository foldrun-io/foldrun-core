// An agent's `resources:` — cores, memory and disk in numbers, over its
// `size:` class's figures one key at a time:
//
//   size: large
//   resources: { cpu: 2, memory: 4Gi, disk: 10Gi }
//
// `size:` stays the form most agents write; this is for the one that knows
// its shape (much memory and one core for a big CSV, much disk for a video).
// The figures are bounded and stepped the way sandbox platforms sell them,
// so steps pack onto a node predictably and a price reads plainly. One
// parser: `foldrun check` reports what it refuses, and the runner applies
// what it accepts — so the two can never disagree about a value.
//
// Pure: no fs, no env. The class's figures come from sizeLimits
// (run-container.ts), which resolveResources there merges these over.

/** What an agent may ask for, and in what steps. */
export const RESOURCE_BOUNDS = {
  cpu: { min: 0.5, max: 8, step: 0.5 },
  memoryMi: { min: 256, max: 16 * 1024, step: 256 },
  diskGi: { min: 1, max: 40, step: 1 },
} as const;

/** The overrides an agent asked for, normalised: cores as a number, memory
 *  in Mi and disk in Gi as quantities both Kubernetes and Docker accept. */
export interface ResourceOverride {
  cpu?: number;
  memory?: string;
  disk?: string;
}

const KEYS = ["cpu", "memory", "disk"] as const;

/** A size in MiB: 512Mi, 4Gi, 1.5Gi (and Docker's 4g, 512m). NaN when it is
 *  not one. A bare number is refused, because 4 could mean four of anything;
 *  so are G and M, which are decimal to Kubernetes and binary to Docker —
 *  an agent's figure means one thing everywhere it is read. */
export function quantityMi(q: unknown): number {
  if (typeof q !== "string") return NaN;
  const m = /^(\d+(?:\.\d+)?)\s*(Mi|Gi|m|g)$/.exec(q.trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  return m[2] === "Gi" || m[2] === "g" ? n * 1024 : n;
}

/** A class's memory figure in MiB, in any spelling an install may set it:
 *  bytes, Kubernetes' Ki/Mi/Gi/Ti and K/M/G/T, Docker's k/m/g/t. Wider than
 *  quantityMi, which reads only what an agent may write. NaN when none. */
export function anyMemoryMi(q: unknown): number {
  const m = /^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|K|M|G|T|k|m|g|t|b)?$/.exec(String(q ?? "").trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  const MiB = 2 ** 20;
  const bin: Record<string, number> = { Ki: 2 ** 10, Mi: MiB, Gi: 2 ** 30, Ti: 2 ** 40, k: 2 ** 10, m: MiB, g: 2 ** 30, t: 2 ** 40, b: 1 };
  const dec: Record<string, number> = { K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  const unit = m[2] ?? "b";
  return (n * (unit in bin ? bin[unit] : dec[unit])) / MiB;
}

const shown = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : Array.isArray(v) ? "a list" : "a map");

/** Read `resources:` — what applies, and why anything else does not. A key
 *  that fails is dropped (the class's figure holds), never guessed at. */
export function readResources(raw: unknown): { value: ResourceOverride; problems: string[] } {
  const value: ResourceOverride = {};
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { value, problems };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { value, problems: [`is ${shown(raw)}, not a map — write {cpu: 2, memory: 4Gi, disk: 10Gi}`] };
  }
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!(KEYS as readonly string[]).includes(k)) problems.push(`\`${k}\` is not one of cpu, memory, disk — it is ignored`);
  }
  const { cpu: C, memoryMi: M, diskGi: D } = RESOURCE_BOUNDS;
  if (r.cpu !== undefined && r.cpu !== null) {
    // A number, or a string of one — never a list or a map coerced (`[2]`
    // is 2 to Number(), and a map's own toString may throw).
    const numeric = typeof r.cpu === "number" || (typeof r.cpu === "string" && /^\s*\d+(\.\d+)?\s*$/.test(r.cpu));
    const n = numeric ? Number(r.cpu) : NaN;
    if (!Number.isFinite(n)) problems.push(`cpu: ${shown(r.cpu)} is not a number of cores — write 2 or 0.5`);
    else if (n < C.min || n > C.max || Math.round(n / C.step) * C.step !== n) problems.push(`cpu: ${n} is not ${C.min} to ${C.max} cores in halves — the class's cores are used`);
    else value.cpu = n;
  }
  if (r.memory !== undefined && r.memory !== null) {
    const mi = quantityMi(r.memory);
    if (!Number.isFinite(mi)) problems.push(`memory: ${shown(r.memory)} is not a size — write 4Gi or 512Mi${/\d\s*[GM]$/.test(String(shown(r.memory))) ? " (Gi and Mi: G and M are read two ways)" : ""}`);
    else if (mi < M.min || mi > M.max || mi % M.step !== 0) problems.push(`memory: ${shown(r.memory)} is not 256Mi to 16Gi in steps of 256Mi — the class's memory is used`);
    else value.memory = `${mi}Mi`;
  }
  if (r.disk !== undefined && r.disk !== null) {
    const mi = quantityMi(r.disk);
    const gi = mi / 1024;
    if (!Number.isFinite(mi)) problems.push(`disk: ${shown(r.disk)} is not a size — write 10Gi`);
    else if (!Number.isInteger(gi) || gi < D.min || gi > D.max) problems.push(`disk: ${shown(r.disk)} is not a whole 1Gi to 40Gi — the class's disk is used`);
    else value.disk = `${gi}Gi`;
  }
  return { value, problems };
}

/** For `foldrun check`: every reason, in one message, or null. */
export function resourcesProblem(v: unknown): string | null {
  const { problems } = readResources(v);
  return problems.length ? problems.join("; ") : null;
}

/** Whether an override changes anything. */
export function hasOverride(o: ResourceOverride | null | undefined): o is ResourceOverride {
  return !!o && (o.cpu !== undefined || o.memory !== undefined || o.disk !== undefined);
}

/** `compute:` — the most the steps running inside one scope may hold
 *  together, in cores, memory and disk (27 Oct 2026: disk, and the scopes
 *  past the account). Written in the account's AGENTS.md (its pool), a
 *  workspace's AGENTS.md (that workspace's pool) and a flow (each run's
 *  pool). Each level only narrows the one above it — the plan or install
 *  caps the account (platform limits.ts). Here it is only read:
 *
 *    compute: { vcpu: 4, memory: 8Gi, disk: 40Gi }
 */
export interface ComputeAsk {
  vcpu?: number;
  memGiB?: number;
  diskGiB?: number;
}

export function readCompute(raw: unknown): { value: ComputeAsk; problems: string[] } {
  const value: ComputeAsk = {};
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { value, problems };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { value, problems: [`is ${shown(raw)}, not a map — write {vcpu: 4, memory: 8Gi, disk: 40Gi}`] };
  }
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k !== "vcpu" && k !== "memory" && k !== "disk") problems.push(`\`${k}\` is not vcpu, memory or disk — it is ignored`);
  }
  if (r.vcpu !== undefined && r.vcpu !== null) {
    const numeric = typeof r.vcpu === "number" || (typeof r.vcpu === "string" && /^\s*\d+(\.\d+)?\s*$/.test(r.vcpu));
    const n = numeric ? Number(r.vcpu) : NaN;
    if (!Number.isFinite(n) || n < 0.5 || Math.round(n * 2) !== n * 2) problems.push(`vcpu: ${shown(r.vcpu)} is not a number of cores, 0.5 or more in halves`);
    else value.vcpu = n;
  }
  if (r.memory !== undefined && r.memory !== null) {
    const mi = quantityMi(r.memory);
    if (!Number.isFinite(mi) || mi < 256) problems.push(`memory: ${shown(r.memory)} is not a size of 256Mi or more — write 8Gi`);
    else value.memGiB = mi / 1024;
  }
  if (r.disk !== undefined && r.disk !== null) {
    const mi = quantityMi(r.disk);
    if (!Number.isFinite(mi) || mi < 1024) problems.push(`disk: ${shown(r.disk)} is not a size of 1Gi or more — write 40Gi`);
    else value.diskGiB = mi / 1024;
  }
  return { value, problems };
}

export function computeProblem(v: unknown): string | null {
  const { problems } = readCompute(v);
  return problems.length ? problems.join("; ") : null;
}
