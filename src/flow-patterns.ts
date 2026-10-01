// Orchestration patterns as markdown edits.
//
// Each pattern a person can reach for — chain a step, run one in parallel,
// route on a verdict, fan out, loop until a critic approves, gate on a
// human, ask a question first, wait, rescue a failure — is a small, exact
// change to a flow file. So is each change to an agent's team: a sub-agent
// delegated to (`subagents:`), a colleague consulted (`agents:`), permission
// to ask a person mid-step (`ask` in `tools:`). This module is those edits,
// once, for every surface that makes them: the dashboard's flow canvas today,
// the CLI's verbs next.
//
// Every edit is line-level surgery. Flow edits compose core's own rewrites
// where one exists (addFlowStep, reorderFlowSteps), so every surface writes
// the same file for the same gesture; what has no rewrite yet — an option
// updateFlowStep does not manage (ask:, wait:, on-fail:, each: rows/items),
// the `!` marker — is done here one step's lines at a time and re-parsed: an
// edit the parser then flags on that step is refused, never written. Agent
// edits touch only the frontmatter lines they name, so comments, key order
// and the prose survive byte for byte — never a YAML re-dump.
//
// Pure: string in, string out. The caller reads and writes the file.

import { parseFlow, addFlowStep, reorderFlowSteps, parseWait, assertSafeName, type FlowStep } from "./store.ts";
import { joinGroup, splitToRail, type Groups } from "./arrange.ts";
import { lintFlow } from "./flow-lint.ts";
import { removalImpact, stepLabel, type RemovalImpact } from "./step-removal.ts";

// ---------- flow files ----------

/** A flow's steps as groups of indices into its parsed steps — what
 *  reorderFlowSteps and the arrange helpers take. */
export function flowGroups(steps: FlowStep[]): Groups {
  const map = new Map<number, number[]>();
  steps.forEach((s, i) => map.set(s.group, [...(map.get(s.group) ?? []), i]));
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

/** The step options a pattern writes. Everything else in a step stays the
 *  author's (and updateFlowStep's) business. */
export const PATTERN_OPTION_KEYS = [
  "ask", "wait", "on-fail", "each", "max", "loop", "until", "verify", "case", "else", "when", "retry", "approve",
] as const;
export type PatternOptionKey = (typeof PATTERN_OPTION_KEYS)[number];
export type PatternOptions = Partial<Record<PatternOptionKey, string | null>>;

export type PatternEdit =
  /** Chain (at.rail: its own group there) or Parallel (at.column: join
   *  the group in that column). Rail 0 is before every group. */
  | {
      op: "insert";
      target: string;
      subflow?: boolean;
      instruction?: string;
      at: { rail: number } | { column: number };
      options?: PatternOptions;
    }
  /** Router: a triage step, then one group of case:/else: branches. */
  | {
      op: "router";
      router: string;
      instruction?: string;
      rail: number;
      cases: { value: string; target: string }[];
      else?: string;
    }
  /** Fan-out, evaluator loop, ask, wait, rescue: options on one step. */
  | { op: "options"; step: number; set: PatternOptions }
  /** Approval gate: the `!` marker. */
  | { op: "approve"; step: number; on: boolean }
  /** Delete one step (removeStep). */
  | { op: "remove"; step: number }
  /** Copy one step beside itself (duplicateStep). */
  | { op: "duplicate"; step: number }
  /** Copied step markdown, placed (pasteSteps). */
  | { op: "paste"; text: string; at: { rail: number } | { column: number } };

const OPTION_RE = /^(\s+)([a-z_-]+):(.*)$/;
const MARKER_RE = /^(\s*\d+)([?!])?(\.?\s+\[\[)/;

function stepAt(raw: string, index: number): FlowStep {
  const s = parseFlow("flow.md", raw).steps[index];
  if (!s) throw new Error(`no step ${index}`);
  return s;
}

/** [first, end) of step `index`'s lines in raw.split("\n"): its step line
 *  through the line before the next step (or the end of the file). */
function stepSpan(raw: string, index: number) {
  const steps = parseFlow("flow.md", raw).steps;
  const s = steps[index];
  if (!s?.line) throw new Error(`no step ${index}`);
  const first = s.line - 1;
  const lines = raw.split("\n");
  const later = steps.map((t) => (t.line ?? 0) - 1).filter((l) => l > first);
  const end = later.length ? Math.min(...later) : lines.length;
  return { lines, first, end };
}

const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

/** Check a value before it is written, in the words the parser would use. */
function checkOption(key: PatternOptionKey, value: string) {
  const n = Number(value);
  switch (key) {
    case "loop":
      if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error("loop: is a whole number of extra cycles, 1 to 5");
      break;
    case "max":
      if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("max: is a whole number of items, 1 to 20");
      break;
    case "retry":
      if (!Number.isInteger(n) || n < 0 || n > 5) throw new Error("retry: is a whole number of extra attempts, at most 5");
      break;
    case "wait":
      if (!/^event$/i.test(value) && parseWait(value) === undefined) throw new Error("wait: is event, or a duration: 90s, 30m, 4h, 3d");
      break;
    case "each":
      if (!/^(lines|items|rows of \S.*)$/.test(value)) throw new Error("each: is lines, items, or rows of <path>");
      break;
    case "on-fail":
      assertSafeName(value.replace(/^\[\[|\]\]$/g, ""), "on-fail agent");
      break;
  }
}

/**
 * Set (or clear, with null or "") options on one step. An option already
 * there is rewritten on its own line, where it was; a new one goes after the
 * step's run of indented lines, at the indent its siblings use — never after
 * prose below the step.
 */
export function setStepOptions(raw: string, index: number, set: PatternOptions): string {
  const before = stepAt(raw, index).problems?.length ?? 0;
  const { lines, first, end } = stepSpan(raw, index);
  const block = lines.slice(first, end);
  const indent = block.slice(1).map((l) => l.match(OPTION_RE)?.[1]).find(Boolean) ?? "   ";
  const keyOf = (l: string) => {
    const k = l.match(OPTION_RE)?.[2];
    return k === "onfail" ? "on-fail" : k;
  };
  for (const [key, given] of Object.entries(set) as [PatternOptionKey, string | null | undefined][]) {
    if (!(PATTERN_OPTION_KEYS as readonly string[]).includes(key)) throw new Error(`a pattern does not write ${key}:`);
    const at = block.findIndex((l, i) => i > 0 && keyOf(l) === key);
    if (given === null || given === undefined || oneLine(given) === "") {
      if (at !== -1) block.splice(at, 1);
      continue;
    }
    let value = oneLine(given);
    if (key === "on-fail") value = `[[${value.replace(/^\[\[|\]\]$/g, "")}]]`;
    checkOption(key, value);
    const line = `${indent}${key}: ${value}`;
    if (at !== -1) block[at] = line;
    else {
      let last = 0;
      while (last + 1 < block.length && /^\s+\S/.test(block[last + 1])) last++;
      block.splice(last + 1, 0, line);
    }
  }
  const out = [...lines.slice(0, first), ...block, ...lines.slice(end)].join("\n");
  const after = stepAt(out, index).problems ?? [];
  if (after.length > before) throw new Error(after[after.length - 1]);
  return out;
}

/** Turn the approval gate on or off: `!` on the step line where it can go;
 *  an optional step (`?`) already has its one marker, so it gets
 *  `approve: true` instead. Off removes either spelling. */
export function setStepApprove(raw: string, index: number, on: boolean): string {
  const { lines, first } = stepSpan(raw, index);
  const m = lines[first].match(MARKER_RE);
  if (!m) throw new Error(`step ${index} is not a step line`);
  const marker = m[2] ?? "";
  if (on) {
    if (stepAt(raw, index).approve) return raw;
    if (marker === "?") return setStepOptions(raw, index, { approve: "true" });
    lines[first] = lines[first].replace(MARKER_RE, "$1!$3");
    return lines.join("\n");
  }
  let out = raw;
  if (marker === "!") {
    lines[first] = lines[first].replace(MARKER_RE, "$1$3");
    out = lines.join("\n");
  }
  return setStepOptions(out, index, { approve: null });
}

/** A new step, placed; the file, the new step's index and its column. */
export function insertFlowStep(
  raw: string,
  o: { target: string; subflow?: boolean; instruction?: string; at: { rail: number } | { column: number }; options?: PatternOptions },
): { text: string; index: number; column: number } {
  let text = addFlowStep(raw, { target: o.target, subflow: o.subflow, instruction: o.instruction });
  const steps = parseFlow("flow.md", text).steps;
  const added = steps.length - 1;
  let groups = flowGroups(steps);
  if ("column" in o.at) {
    const anchor = groups[o.at.column]?.[0];
    if (anchor === undefined || anchor === added) throw new Error(`no step ${o.at.column + 1} to run beside`);
    groups = joinGroup(groups, added, anchor);
  } else {
    groups = splitToRail(groups, added, o.at.rail);
  }
  text = reorderFlowSteps(text, groups);
  const index = groups.flat().indexOf(added);
  const column = groups.findIndex((g) => g.includes(added));
  if (o.options && Object.keys(o.options).length) text = setStepOptions(text, index, o.options);
  return { text, index, column };
}

/** The problems that make `check` fail, as a multiset of messages: the
 *  parser's own per-step ones and the lint's error-level ones. */
function errorsOf(raw: string): string[] {
  const flow = parseFlow("flow.md", raw);
  return [
    ...flow.steps.flatMap((s) => s.problems ?? []),
    ...lintFlow(flow).filter((w) => w.level === "error").map((w) => w.message.replace(/step \d+/g, "step")),
  ];
}

/**
 * What else changes when step `index` goes — said before it goes. The rule
 * lives in step-removal.ts, which imports no parser, so the canvas can say
 * it in the browser from the steps it already has.
 */
export function removeStepImpact(raw: string, index: number): RemovalImpact {
  return removalImpact(parseFlow("flow.md", raw).steps, index);
}

/**
 * Delete step `index` (its index in the parsed steps): its step line and the
 * indented option lines under it, nothing else — prose after the step stays.
 * When that empties its group, the groups after it renumber so there is no
 * gap. The agent's file is not touched. Refused when the result would give
 * `check` an error it did not have (a `case:` step left first, with nothing
 * to route on).
 */
export function removeStep(raw: string, index: number): string {
  const steps = parseFlow("flow.md", raw).steps;
  if (!Number.isInteger(index) || !steps[index]) throw new Error(`no step ${index + 1}`);
  const emptied = flowGroups(steps).some((g) => g.length === 1 && g[0] === index);
  const { lines, first } = stepSpan(raw, index);
  let end = first + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
  let out = [...lines.slice(0, first), ...lines.slice(end)].join("\n");
  if (emptied && steps.length > 1) out = reorderFlowSteps(out, flowGroups(parseFlow("flow.md", out).steps));

  assertNoNewErrors(raw, out, `removing ${stepLabel(steps, index)}`);
  return out;
}

/** Throw when `out` has a `check` error `raw` did not — counted as a
 *  multiset, so a second copy of an existing error is a new one. */
function assertNoNewErrors(raw: string, out: string, what: string) {
  const had = new Map<string, number>();
  for (const e of errorsOf(raw)) had.set(e, (had.get(e) ?? 0) + 1);
  for (const e of errorsOf(out)) {
    const n = had.get(e) ?? 0;
    if (n) had.set(e, n - 1);
    else throw new Error(`${what} would leave the flow with an error: ${e}`);
  }
}

/** The lines of step `index`: its step line and the indented lines directly
 *  under it (removeStep's rule) — never the prose or blank lines after. */
function stepBlockLines(raw: string, index: number): { lines: string[]; first: number; end: number } {
  const { lines, first } = stepSpan(raw, index);
  let end = first + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
  return { lines, first, end };
}

/** Step `index` as markdown — what the canvas copies to the clipboard and
 *  pasteSteps reads back: the step line (group number, `?`/`!` marker,
 *  link, instruction) and its indented options. */
export function stepSource(raw: string, index: number): string {
  const { lines, first, end } = stepBlockLines(raw, index);
  return lines.slice(first, end).map((l) => l.replace(/\r$/, "")).join("\n");
}

/**
 * Duplicate step `index`: the copy — step line with its marker, every
 * indented option — goes directly under the original with the same group
 * number, so it runs in parallel with it. Nothing else moves. Refused when
 * `check` would gain an error.
 */
export function duplicateStep(raw: string, index: number): string {
  const steps = parseFlow("flow.md", raw).steps;
  if (!Number.isInteger(index) || !steps[index]) throw new Error(`no step ${index + 1}`);
  const { lines, first, end } = stepBlockLines(raw, index);
  const out = [...lines.slice(0, end), ...lines.slice(first, end), ...lines.slice(end)].join("\n");
  assertNoNewErrors(raw, out, `duplicating ${stepLabel(steps, index)}`);
  return out;
}

const PASTE_STEP_RE = /^\s*(\d+)([?!])?(\.?\s+\[\[.*)$/;

/** Copied step markdown → blocks, each with the group number it was
 *  copied with. Blank lines between blocks are fine; anything else that is
 *  neither a step line nor an indented line under one is refused. */
function pastedBlocks(text: string): { group: number; lines: string[] }[] {
  const blocks: { group: number; lines: string[] }[] = [];
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const m = line.match(PASTE_STEP_RE);
    if (m) {
      blocks.push({ group: Number(m[1]), lines: [`${m[1]}${m[2] ?? ""}${m[3]}`] });
    } else if (/^\s+\S/.test(line) && blocks.length) {
      blocks[blocks.length - 1].lines.push(line);
    } else {
      throw new Error(`not a copied step: "${line.trim().slice(0, 60)}" — paste step lines and their indented options`);
    }
  }
  if (!blocks.length) throw new Error("nothing to paste — no step line (\"1. [[agent]] — …\")");
  return blocks;
}

/**
 * Paste copied steps (stepSource output, one block or several) into a flow.
 * Steps copied with the same group number stay parallel with each other.
 * `{ rail }` places the pasted groups as their own consecutive groups there
 * (0 is before every group); `{ column }` puts every pasted step in that
 * existing group. Groups renumber; prose stays where it was. Returns the
 * file and the pasted steps' indices in it. Refused when the paste does not
 * parse as those steps, or when `check` would gain an error.
 */
export function pasteSteps(
  raw: string,
  text: string,
  at: { rail: number } | { column: number },
): { text: string; indices: number[] } {
  const blocks = pastedBlocks(text);
  const before = parseFlow("flow.md", raw).steps;
  const eol = eolOf(raw);
  const top = before.reduce((m, s) => Math.max(m, s.group), 0);
  // Pasted groups get numbers above every existing one, so they sort last
  // and their indices are the tail of the parse; reorderFlowSteps then puts
  // them where they belong and renumbers everything.
  const order = [...new Set(blocks.map((b) => b.group))].sort((a, b) => a - b);
  const renumbered = blocks.map((b) => {
    const g = top + 1 + order.indexOf(b.group);
    return [b.lines[0].replace(/^\d+/, String(g)), ...b.lines.slice(1)];
  });
  const cr = eol === "\r\n" ? "\r" : "";
  const added = renumbered.flat().map((l) => l + cr);
  let merged: string;
  if (before.length) {
    // Above the first step line: whatever prose trails the last step stays
    // with it instead of following the pasted ones.
    const lines = raw.split("\n");
    const first = Math.min(...before.map((s) => (s.line ?? 1) - 1));
    merged = [...lines.slice(0, first), ...added, ...lines.slice(first)].join("\n");
  } else {
    merged = `${raw.replace(/\s+$/, "")}${eol}${eol}${added.map((l) => l.replace(/\r$/, "")).join(eol)}${eol}`;
  }

  const steps = parseFlow("flow.md", merged).steps;
  if (steps.length !== before.length + blocks.length) {
    throw new Error(`the paste parsed as ${steps.length - before.length} steps, not ${blocks.length}`);
  }
  const pasted = steps.map((_, i) => i).slice(before.length);
  const groups = flowGroups(steps);
  const old = groups.filter((g) => g.every((i) => i < before.length));
  const fresh = groups.filter((g) => g.some((i) => i >= before.length));
  let next: Groups;
  if ("column" in at) {
    if (!old[at.column]) throw new Error(`no step ${at.column + 1} to run beside`);
    next = old.map((g, k) => (k === at.column ? [...g, ...pasted] : g));
  } else {
    if (!Number.isInteger(at.rail) || at.rail < 0 || at.rail > old.length) throw new Error(`no place ${at.rail} — 0 to ${old.length}`);
    next = [...old.slice(0, at.rail), ...fresh, ...old.slice(at.rail)];
  }
  const out = reorderFlowSteps(merged, next);
  assertNoNewErrors(raw, out, "pasting");
  const flat = next.flat();
  return { text: out, indices: pasted.map((i) => flat.indexOf(i)).sort((a, b) => a - b) };
}

/** One pattern, applied to a flow file. */
export function applyPatternEdit(raw: string, edit: PatternEdit): string {
  switch (edit.op) {
    case "insert":
      return insertFlowStep(raw, edit).text;
    case "router": {
      const cases = (edit.cases ?? []).filter((c) => oneLine(c.value ?? "") && c.target);
      if (!cases.length) throw new Error("a router needs at least one case: and its agent");
      const head = insertFlowStep(raw, { target: edit.router, instruction: edit.instruction, at: { rail: edit.rail } });
      let text = head.text;
      const branches: { target: string; options: PatternOptions }[] = [
        ...cases.map((c) => ({ target: c.target, options: { case: oneLine(c.value) } })),
        ...(edit.else ? [{ target: edit.else, options: { else: "true" } }] : []),
      ];
      branches.forEach((b, k) => {
        text = insertFlowStep(text, {
          target: b.target,
          at: k === 0 ? { rail: head.column + 1 } : { column: head.column + 1 },
          options: b.options,
        }).text;
      });
      return text;
    }
    case "options":
      return setStepOptions(raw, edit.step, edit.set);
    case "approve":
      return setStepApprove(raw, edit.step, edit.on);
    case "remove":
      return removeStep(raw, edit.step);
    case "duplicate":
      return duplicateStep(raw, edit.step);
    case "paste":
      return pasteSteps(raw, edit.text, edit.at).text;
    default:
      throw new Error(`unknown pattern edit ${(edit as { op?: unknown }).op}`);
  }
}

// ---------- agent files ----------

/** The frontmatter list fields an agent's team lives in: whom it delegates
 *  to, whom it consults, and what it may do (`ask` among them). */
export const TEAM_LIST_KEYS = ["subagents", "agents", "tools"] as const;
export type TeamListKey = (typeof TEAM_LIST_KEYS)[number];

function eolOf(raw: string) {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

function frontBounds(lines: string[]): { close: number } | null {
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === "---") return { close: i };
  return null;
}

/** A list item as the parser reads it: quotes and [[ ]] stripped. */
function itemName(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "").replace(/^\[\[|\]\]$/g, "").trim();
}

function splitComment(value: string): { value: string; comment: string } {
  const m = value.match(/^(.*?)(\s+#.*)$/);
  return m ? { value: m[1], comment: m[2] } : { value, comment: "" };
}

function keyLine(lines: string[], close: number, key: string) {
  const re = new RegExp(`^${key.replace(/[-]/g, "\\-")}:(.*)$`);
  for (let i = 1; i < close; i++) {
    const m = lines[i].match(re);
    if (m) return { index: i, rest: m[1] };
  }
  return null;
}

/** Block-style item lines under a key: `  - name`, until anything else. */
function blockItems(lines: string[], from: number, close: number) {
  const items: number[] = [];
  for (let i = from + 1; i < close; i++) {
    const l = lines[i];
    if (/^\s*-(\s|$)/.test(l)) items.push(i);
    else if (/^\s*(#.*)?$/.test(l)) continue; // blank or comment inside the block
    else break;
  }
  return items;
}

const blockItemName = (line: string) => itemName(line.replace(/^\s*-\s*/, "").replace(/\s+#.*$/, ""));

/** The names a frontmatter list holds, read the way the file says them. */
export function frontmatterList(raw: string, key: string): string[] {
  const lines = raw.split(eolOf(raw));
  const b = frontBounds(lines);
  if (!b) return [];
  const k = keyLine(lines, b.close, key);
  if (!k) return [];
  const v = splitComment(k.rest).value.trim();
  if (v.startsWith("[")) return v.replace(/^\[|\]$/g, "").split(",").map(itemName).filter(Boolean);
  if (v) return [itemName(v)];
  return blockItems(lines, k.index, b.close).map((i) => blockItemName(lines[i])).filter(Boolean);
}

/**
 * Add `name` to, or remove it from, the list under `key`, touching only the
 * lines that list is on. Flow style (`key: [a, b]`) stays flow style, block
 * style stays block style, a trailing `# comment` stays put, and the other
 * items keep their spelling. A list emptied by a removal is written
 * `key: []` rather than deleted: the file still says "none", which for
 * `tools:` is not the same as saying nothing.
 */
export function editFrontmatterList(raw: string, key: string, name: string, action: "add" | "remove"): string {
  const eol = eolOf(raw);
  const lines = raw.split(eol);
  const b = frontBounds(lines);
  if (!b) return action === "remove" ? raw : ["---", `${key}: [${name}]`, "---", ...lines].join(eol);
  const has = frontmatterList(raw, key).includes(name);
  if ((action === "add") === has) return raw;
  const k = keyLine(lines, b.close, key);
  if (!k) {
    lines.splice(b.close, 0, `${key}: [${name}]`);
    return lines.join(eol);
  }
  const { value, comment } = splitComment(k.rest);
  const v = value.trim();
  if (v) {
    // Flow style, or a lone scalar (read as a one-item list): that one line.
    const tokens = v.startsWith("[") ? v.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean) : [v];
    const next = action === "add" ? [...tokens, name] : tokens.filter((t) => itemName(t) !== name);
    lines[k.index] = `${key}: [${next.join(", ")}]${comment}`;
    return lines.join(eol);
  }
  const items = blockItems(lines, k.index, b.close);
  if (action === "add") {
    const indent = items.length ? lines[items[0]].match(/^(\s*)-/)![1] : "  ";
    lines.splice(items.length ? items[items.length - 1] + 1 : k.index + 1, 0, `${indent}- ${name}`);
    return lines.join(eol);
  }
  const drop = items.filter((i) => blockItemName(lines[i]) === name);
  for (const i of [...drop].reverse()) lines.splice(i, 1);
  if (drop.length === items.length) lines[k.index] = `${key}: []${comment}`;
  return lines.join(eol);
}

const YAML_WORDS = /^(true|false|yes|no|on|off|null|~|y|n)$/i;

/** A YAML scalar for a one-line value: plain when plain reads back as the
 *  same string, double-quoted (JSON is valid YAML) when it would not. */
export function yamlScalar(value: string): string {
  const v = oneLine(value);
  // Plain in block context may hold anything but ": " and " #", once it
  // starts with a letter; YAML's words for true/false/null are not strings.
  const plain = /^[A-Za-z(]/.test(v) && !/:(\s|$)|\s#|\t/.test(v) && !YAML_WORDS.test(v);
  return plain ? v : JSON.stringify(v);
}

/** Set one scalar key — `description:`, `model:`. Replaces its line (and the
 *  indented lines of a `>`/`|` block under it); absent, it goes right after
 *  `name:`, or last. */
export function setFrontmatterScalar(raw: string, key: string, value: string): string {
  const eol = eolOf(raw);
  const lines = raw.split(eol);
  const b = frontBounds(lines);
  const line = `${key}: ${yamlScalar(value)}`;
  if (!b) return ["---", line, "---", ...lines].join(eol);
  const k = keyLine(lines, b.close, key);
  if (k) {
    const { value: v, comment } = splitComment(k.rest);
    let end = k.index + 1;
    if (/^\s*[|>][-+]?\d*\s*$/.test(v) || !v.trim()) {
      while (end < b.close && /^\s+\S/.test(lines[end])) end++;
    }
    lines.splice(k.index, end - k.index, `${line}${comment}`);
    return lines.join(eol);
  }
  const name = keyLine(lines, b.close, "name");
  lines.splice(name ? name.index + 1 : b.close, 0, line);
  return lines.join(eol);
}

/** A new agent file: the template with the answers to "what is it for"
 *  and "which model" written into it, the rest as the template wrote it. */
export function newAgentFile(template: string, o: { description?: string; model?: string }): string {
  let out = template;
  if (o.description?.trim()) out = setFrontmatterScalar(out, "description", o.description);
  if (o.model?.trim()) out = setFrontmatterScalar(out, "model", o.model);
  return out;
}
