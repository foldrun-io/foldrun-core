// Editing AGENTS.md frontmatter one key at a time, in place.
//
// AGENTS.md is a file people write by hand — comments, spacing, key order
// are theirs. A settings form that re-serialised the whole frontmatter
// would erase all of that on the first Save. So a key is replaced
// textually: its block (the `key:` line and the indented lines under it)
// is cut out, and the new block is appended where it stood. Everything
// else in the file is untouched. Null removes the key.

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const FRONT = /^(---\r?\n)([\s\S]*?)(\r?\n---)(\r?\n|$)/;

/** The frontmatter of a directory's AGENTS.md (or project.md), or {}. */
export function readAgentsMdKeys(dir: string): Record<string, unknown> {
  for (const name of ["AGENTS.md", "project.md"]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    try {
      return (matter(fs.readFileSync(file, "utf8")).data ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

/** One key as YAML lines, the way gray-matter writes frontmatter — the same
 *  serialiser that already reads these files, so nothing new to disagree. */
function dumpKey(key: string, value: unknown): string[] {
  const block = matter.stringify("", { [key]: value });
  const m = block.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return (m ? m[1] : `${key}: ${String(value)}`).trimEnd().split("\n");
}

/** The text of `content` with each key in `patch` replaced (or removed for
 *  null), everything else byte for byte as it was. A file with no
 *  frontmatter gets one. */
export function patchFrontmatter(content: string, patch: Record<string, unknown | null>): string {
  const m = content.match(FRONT);
  let open = "---\n";
  let body = "";
  let close = "\n---";
  let rest = content;
  if (m) {
    [, open, body, close] = m;
    rest = content.slice(m[0].length - (m[4] ?? "").length);
  } else {
    rest = content.startsWith("\n") ? content : `\n${content}`;
  }
  let lines = body === "" ? [] : body.split("\n");
  for (const [key, value] of Object.entries(patch)) {
    const at = lines.findIndex((l) => new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(l));
    let end = at;
    if (at !== -1) {
      end = at + 1;
      // The block continues while lines are indented or blank-inside-block.
      while (end < lines.length && (/^[ \t]/.test(lines[end]) || lines[end].trim() === "")) end++;
      // A blank line at the block's foot belongs to what follows.
      while (end > at + 1 && lines[end - 1].trim() === "") end--;
    }
    const replacement = value === null || value === undefined ? [] : dumpKey(key, value);
    if (at === -1) lines = [...lines, ...replacement];
    else lines = [...lines.slice(0, at), ...replacement, ...lines.slice(end)];
  }
  const front = lines.length ? `${open}${lines.join("\n")}${close}` : "";
  if (!front) return rest.replace(/^(\r?\n)+/, "");
  return `${front}${m ? m[4] ?? "\n" : "\n"}${rest.replace(/^\r?\n/, m ? "" : "")}`;
}

/** Apply a frontmatter patch to a directory's AGENTS.md, creating the file
 *  when the directory has none. Returns the new content. */
export function setAgentsMdKeys(dir: string, patch: Record<string, unknown | null>): string {
  const file = path.join(dir, "AGENTS.md");
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const after = patchFrontmatter(before, patch);
  fs.writeFileSync(file, after);
  return after;
}
