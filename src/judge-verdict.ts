// What a judge said: the PASS or FAIL alone on its last line, after its
// reasoning. Shared by the eval judge (evals.ts) and a flow step's
// `verify: judge:` (step-exec.ts), which ask for the same shape.
//
// The word comes last because, asked for it first, a judge commits before
// it has looked and then argues the other way — "FAIL … which meets the
// criterion" (vaza evals, 21 Oct 2026).

import { EFFORT_LEVELS } from "./frontmatter-fields.ts";

/** The line to end a judge prompt with. */
export const JUDGE_VERDICT_INSTRUCTION =
  "Check each part against the text in a few short sentences. Then, on the last line and alone, write exactly PASS or FAIL — PASS only if every part holds.";

/**
 * The judge's verdict: the PASS or FAIL alone on its last line, with the
 * reasoning before it as the detail. An answer in the old shape (the word
 * first) still reads; one with no verdict at all is a FAIL that says so.
 */
export function judgeVerdict(text: string): { passed: boolean; detail: string; decided?: boolean } {
  const lines = text.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const word = (l: string | undefined) => /^[*_`#\s]*(PASS|FAIL)[*_`.\s]*$/i.exec(l ?? "")?.[1]?.toUpperCase();
  let verdict = word(lines[lines.length - 1]);
  let reason = lines.slice(0, -1).join(" ");
  if (!verdict) {
    const first = /^[*_`#\s]*(PASS|FAIL)\b[*_`:.\s-]*(.*)$/i.exec(lines[0] ?? "");
    if (first) {
      verdict = first[1]!.toUpperCase();
      reason = [first[2], ...lines.slice(1)].join(" ").trim();
    }
  }
  // `decided: false` lets a grader tell "no verdict" from "FAIL": an eval
  // case still fails on it, a live run's grade is left undecided.
  if (!verdict) return { passed: false, decided: false, detail: `judge gave no PASS or FAIL: ${text.trim().slice(0, 300) || "nothing"}` };
  // The end of the reasoning is the part that decided it.
  const why = reason.length > 400 ? `…${reason.slice(-400)}` : reason;
  return { passed: verdict === "PASS", detail: `${verdict}${why ? ` — ${why}` : ""}` };
}

/** `judge:` in AGENTS.md — the model and effort every judge in the workspace
 *  grades with, unless an eval names its own. `model` is a tier or alias as
 *  anywhere else; what is wrong with the block, in words, for check. */
export function parseJudge(raw: unknown): { model?: string; effort?: string; problems: string[] } {
  if (raw === undefined || raw === null) return { problems: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) return { problems: ["judge: is a block — {model: fast | default | max, effort: low…max}"] };
  const o = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of Object.keys(o)) if (k !== "model" && k !== "effort") problems.push(`judge: ${k} — not a key; the keys are model and effort`);
  const model = typeof o.model === "string" && o.model.trim() ? o.model.trim() : undefined;
  if (o.model !== undefined && !model) problems.push("judge: model — a tier (fast, default, max), an alias or a model id");
  const effort = typeof o.effort === "string" && (EFFORT_LEVELS as readonly string[]).includes(o.effort.trim()) ? o.effort.trim() : undefined;
  if (o.effort !== undefined && !effort) problems.push(`judge: effort ${String(o.effort)} — low, medium, high, xhigh or max`);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), problems };
}
