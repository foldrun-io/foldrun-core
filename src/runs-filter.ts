// Search over runs (FOL-72 step 9): one filter for the runs API, the runs
// pages and `foldrun runs`, read off the run index — the tools each step
// called, its tool errors, its agent and model, tokens and how long it took.
// Pure.

export interface RunFilter {
  /** A step called a tool whose name contains this (`web`, `crm_export`). */
  tool?: string;
  /** A tool call errored. */
  toolError?: boolean;
  /** A step was this agent. */
  agent?: string;
  /** A step ran a model whose name contains this (`haiku`, `opus`). */
  model?: string;
  /** The run read at least this many input tokens, all steps together. */
  minTokens?: number;
  /** The run took at least this many seconds. */
  minSecs?: number;
}

/** The query parameters a filter comes from: tool, tool_error, agent,
 *  model, min_tokens, min_secs. Unreadable numbers are refused in words. */
export function parseRunFilter(q: { get(name: string): string | null }): { filter: RunFilter; problems: string[] } {
  const filter: RunFilter = {};
  const problems: string[] = [];
  const text = (k: string) => q.get(k)?.trim() || undefined;
  const tool = text("tool");
  if (tool) filter.tool = tool.toLowerCase();
  const te = text("tool_error");
  if (te) filter.toolError = te === "1" || te === "true" || te === "yes";
  const agent = text("agent");
  if (agent) filter.agent = agent;
  const model = text("model");
  if (model) filter.model = model.toLowerCase();
  for (const [k, field] of [["min_tokens", "minTokens"], ["min_secs", "minSecs"]] as const) {
    const v = text(k);
    if (v === undefined) continue;
    // "50k" and "1.5k" are thousands (Codex review: "1.5k" read as 1.5).
    const kilo = /^(\d+(?:\.\d+)?)k$/i.exec(v);
    const n = kilo ? Number(kilo[1]) * 1000 : Number(v);
    if (!Number.isFinite(n) || n < 0) problems.push(`${k} is a number (${k === "min_tokens" ? "50000 or 50k" : "seconds"}), not ${v}`);
    else filter[field] = n;
  }
  return { filter, problems };
}

export const isEmptyFilter = (f: RunFilter) => Object.keys(f).length === 0;

type FilterableStep = {
  agent: string;
  model?: string;
  tools?: string[];
  toolErrors?: number;
  /** A whole record has events instead of the index's tools/toolErrors. */
  events?: { type: string; text: string; ms?: number; err?: boolean }[];
  tokens?: { input?: number } | null;
  startedAt?: string;
  finishedAt?: string;
};
type FilterableRun = { startedAt: string; finishedAt?: string | null; steps: FilterableStep[] };

/** The index's facts, or worked out from a whole record's events (Codex
 *  review: the workspace runs page reads whole records). */
function factsOf(s: FilterableStep): { tools: string[]; toolErrors: number } {
  if (s.tools !== undefined || s.toolErrors !== undefined || !s.events) return { tools: s.tools ?? [], toolErrors: s.toolErrors ?? 0 };
  const tools = new Set<string>();
  let errs = 0;
  for (const e of s.events) {
    if (e.type !== "tool") continue;
    if (e.ms == null) tools.add(e.text);
    else if (e.err) errs++;
  }
  return { tools: [...tools], toolErrors: errs };
}

export function matchesRunFilter(run: FilterableRun, f: RunFilter, now = Date.now()): boolean {
  const steps = (run.steps ?? []).map((s) => ({ ...s, ...factsOf(s) }));
  if (f.tool && !steps.some((s) => (s.tools ?? []).some((t) => t.toLowerCase().includes(f.tool!)))) return false;
  if (f.toolError !== undefined && steps.some((s) => (s.toolErrors ?? 0) > 0) !== f.toolError) return false;
  if (f.agent && !steps.some((s) => s.agent === f.agent)) return false;
  if (f.model && !steps.some((s) => (s.model ?? "").toLowerCase().includes(f.model!))) return false;
  if (f.minTokens !== undefined && steps.reduce((n, s) => n + (s.tokens?.input ?? 0), 0) < f.minTokens) return false;
  if (f.minSecs !== undefined) {
    const secs = ((run.finishedAt ? Date.parse(run.finishedAt) : now) - Date.parse(run.startedAt)) / 1000;
    if (!(secs >= f.minSecs)) return false;
  }
  return true;
}
