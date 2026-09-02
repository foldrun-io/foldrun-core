// A frontmatter list that names files — `tools:`, `skills:`, `agents:`,
// `after:` — read the same way whether an entry is bare or a `[[link]]`.
//
// `[[name]]` is the format's one reference syntax, and until now the
// frontmatter was the last place a name had to be bare. The rule is one
// sentence: if it names a file, you can link it. Agents, flows, skills,
// tools, knowledge and memory are files; secrets, model and size are values.
//
// YAML is the complication. To YAML, `- [[site_repo]]` is a nested list
// (`[["site_repo"]]`), and `tools: [read, [[site_repo]]]` is a list holding
// a string and a list. So an entry that arrives as an array IS a link — the
// brackets were consumed by the parser — and one that arrives as the string
// "[[x]]" (quoted, or from a step option line) is the same link. Both read
// as the name with `linked: true`; a bare string reads as `linked: false`.
// The distinction matters once: a linked name can only mean one of the
// author's files, so `[[search]]` is your tool and `search` is the runtime's
// group. Everywhere else the two are the same name.

/** One entry of a file-naming list. `mode` is the value of a map-form
 *  entry — `{bash: ask}` — and null for a plain name. */
export interface Ref {
  name: string;
  linked: boolean;
  mode: string | null;
}

/** The name inside `[[…]]`, with `flow:` and surrounding space kept. */
export function stripLink(raw: string): { name: string; linked: boolean } {
  const s = raw.trim();
  const m = s.match(/^\[\[(.*)\]\]$/);
  return m ? { name: m[1].trim(), linked: true } : { name: s, linked: false };
}

/** The first string anywhere inside a nested array — what YAML made of
 *  `[[x]]`. Deeper nesting (`[[[x]]]`) collapses to the same name. */
function innermost(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = innermost(v);
      if (s !== null) return s;
    }
  }
  return null;
}

/**
 * Every entry of a list field, in order, empty names dropped. Accepts the
 * shapes a file can carry: an inline or block list of names, links or maps;
 * a single name; or Claude Code's comma string (`tools: Read, Grep`).
 */
export function refList(raw: unknown): Ref[] {
  if (raw === undefined || raw === null) return [];
  const entries: unknown[] =
    Array.isArray(raw) ? raw : typeof raw === "string" && raw.includes(",") ? raw.split(",") : [raw];
  const out: Ref[] = [];
  for (const entry of entries) {
    if (entry === null || entry === undefined) continue;
    if (Array.isArray(entry)) {
      const name = innermost(entry);
      if (name !== null) {
        const inner = stripLink(name);
        if (inner.name) out.push({ name: inner.name, linked: true, mode: null });
      }
      continue;
    }
    if (typeof entry === "object") {
      const [key, value] = Object.entries(entry as Record<string, unknown>)[0] ?? [];
      if (!key) continue;
      const { name, linked } = stripLink(key);
      if (name) out.push({ name, linked, mode: value === undefined || value === null ? null : String(value) });
      continue;
    }
    const { name, linked } = stripLink(String(entry));
    if (name) out.push({ name, linked, mode: null });
  }
  return out;
}

/** Just the names — for a reader that does not care how they were spelt. */
export function refNames(raw: unknown): string[] {
  return refList(raw).map((r) => r.name);
}
