// What [[ ]] can name, as one list.
//
// This existed twice and the two copies disagreed. The runner's resolver
// indexed the file store under its real directory name (`storage/`), while
// the editor offered the same files as `files/…` — a label left over from
// before the rename. Accepting that suggestion produced a link that matched
// nothing, so the model received two literal brackets where a path was meant.
// The same rename had already caused one silent failure elsewhere; this is
// the second, and the reason the list now has one definition.
//
// The rule this encodes: the editor may only offer what the runner can
// resolve. tests/doclinks-consistency.test.ts asserts the round trip on a
// real workspace, so a future rename fails a test instead of a run.

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import { STORAGE_DIR } from "./store.ts";

export interface LinkableDoc {
  /** What a person types between the brackets. */
  name: string;
  /** Shown beside it in the list. */
  hint: string;
}

/** The directories a bare [[name]] may point at, matching the resolver. */
export const LINKABLE_DIRS = [STORAGE_DIR, "state", "knowledge", "memory", "skills", "outputs"];

/**
 * Everything [[ ]] resolves to in this workspace, in the order a person
 * would want it: documents first, then the file store, then the folders.
 *
 * `workspaceRoot` is the workspace directory itself. `storageFiles` is the
 * hosted store's listing when there is one; local installs pass nothing and
 * the plain `storage/` directory on disk is walked instead — the same two
 * sources, in the same order, that the resolver consults.
 */
export function linkableDocs(
  workspaceRoot: string,
  storageFiles: { path: string }[] = [],
  limit = 300,
): LinkableDoc[] {
  const out: LinkableDoc[] = [];

  for (const kind of ["knowledge", "memory"] as const) {
    const dir = path.join(workspaceRoot, kind);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { recursive: true }).map(String)) {
      if (!entry.endsWith(".md")) continue;
      // index.md and log.md are generated views of the bundle, not concepts
      // to link at — offering them invites a link to a file that will be
      // rewritten under it.
      const base = path.basename(entry);
      if (base === "index.md" || base === "log.md") continue;
      let title = "";
      try {
        const data = matter(fs.readFileSync(path.join(dir, entry), "utf8")).data as Record<string, unknown>;
        for (const key of ["title", "name"] as const) {
          if (typeof data?.[key] === "string" && data[key]) {
            title = data[key] as string;
            break;
          }
        }
      } catch {
        // unparseable frontmatter still links by filename
      }
      out.push({
        name: entry.split(path.sep).join("/").replace(/\.md$/, ""),
        hint: `${kind}${title ? ` — ${title}` : ""}`,
      });
    }
  }

  // state/ — what a recurring flow reads from its own past runs. Offered by
  // path, like the file store and unlike knowledge/, because these are data
  // files rather than documents with a title.
  const stateDir = path.join(workspaceRoot, "state");
  if (fs.existsSync(stateDir)) {
    for (const entry of fs.readdirSync(stateDir, { recursive: true }).map(String)) {
      try {
        if (!fs.statSync(path.join(stateDir, entry)).isFile()) continue;
      } catch {
        continue;
      }
      out.push({ name: `state/${entry.split(path.sep).join("/")}`, hint: "state" });
    }
  }

  // The file store, under the directory the resolver actually indexes.
  const seen = new Set<string>();
  for (const f of storageFiles) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    out.push({ name: `${STORAGE_DIR}/${f.path}`, hint: "file" });
  }
  const filesDir = path.join(workspaceRoot, STORAGE_DIR);
  if (fs.existsSync(filesDir)) {
    for (const entry of fs.readdirSync(filesDir, { recursive: true }).map(String)) {
      const fwd = entry.split(path.sep).join("/");
      if (fwd.startsWith(".store/") || seen.has(fwd)) continue;
      try {
        if (!fs.statSync(path.join(filesDir, entry)).isFile()) continue;
      } catch {
        continue;
      }
      seen.add(fwd);
      out.push({ name: `${STORAGE_DIR}/${fwd}`, hint: "file" });
    }
  }

  // The folders themselves. The resolver has always accepted these — an
  // instruction that says WHERE without naming a file is a real thing to
  // write — and nothing offered them, so the capability was undiscoverable.
  for (const dir of LINKABLE_DIRS) {
    if (fs.existsSync(path.join(workspaceRoot, dir))) {
      out.push({ name: dir, hint: "the whole folder" });
    }
  }

  return out.slice(0, limit);
}
