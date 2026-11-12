// Where the revision journal's entries are kept (FOL-126 phase 4, item 3).
//
// The journal (workspace-revisions.ts) writes every change down BEFORE it is
// queued for a commit, and removes it once committed. Until now "written down"
// meant a file under <data>/.revision-journal/ — on the shared volume, which
// the storage refactor retires. So the place is a seam:
//
//   fsJournalStore   the files, as before: the default, and the only one a
//                    laptop or a Compose install without a database ever has.
//                    A hosted install keeps it as a LEGACY source, replayed at
//                    boot and drained, so switching loses nothing.
//   (platform)       pgJournalStore (src/journal-pg.ts): a table, behind the
//                    same calls, registered where there is a database.
//
// The calls are synchronous (the writers that journal are), and an entry's
// `handle` is whatever the store needs to find it again.

import fs from "node:fs";
import path from "node:path";

/** What is stored: the whole entry (new content only, never the old text). */
export interface JournalRecord {
  /** 2: some file is not text and rides as base64 (`enc`). */
  v: 1 | 2;
  tenant: string;
  workspace: string;
  id: string;
  files: { path: string; before: null; after: string | null; base?: string | null; handed?: string | null; enc?: "base64" }[];
  by: string;
  message: string;
  at: string;
  restoredFrom?: string;
  /** A run's copy-back: the revisions (workspace head, state head) its stage-in
   *  started from. Each file's base is read from these, not from the folder. */
  baseRev?: { workspace: string | null; state: string | null };
}

export interface JournalStore {
  /** Which store this is, for logs ("files", "database"). */
  readonly kind: string;
  /** Write the entry down; throws if it cannot. Returns its handle. Putting an
   *  id that is already there answers the existing handle. */
  put(rec: JournalRecord): string;
  /** Forget one entry. Safe to repeat. */
  remove(tenant: string, workspace: string, handle: string): void;
  /** Every workspace that has entries. */
  workspaces(): { tenant: string; workspace: string }[];
  /** One workspace's entries, oldest first, with how long each has been there. */
  entries(tenant: string, workspace: string): { handle: string; ageMs: number }[];
  /** Read one entry; throws for one that is torn or foreign. */
  read(tenant: string, workspace: string, handle: string): JournalRecord;
  /** Keep an unreadable entry out of every later replay, without destroying it. */
  setAside(tenant: string, workspace: string, handle: string): void;
  /** Housekeeping before a replay: debris of a write that died half way (files only). */
  sweep(tenant: string, workspace: string, olderThanMs: number): void;
  /** Remove everything of one workspace, or of the whole account. Safe to repeat. */
  drop(tenant: string, workspace?: string): void;
  /** A workspace was renamed: its entries not held by a live queue (a dead
   *  process's) now belong to the new name. Handles of entries that were
   *  moved are NOT promised to stay valid: a caller holding some forgets them
   *  first and puts them again under the new name. */
  move(tenant: string, from: string, to: string): void;
}

/** The files: <root>/<tenant>/<workspace>/<time>-<seq>-<id>.json, tmp + rename. */
export function fsJournalStore(root: () => string): JournalStore {
  let seq = 0;
  const dirOf = (tenant: string, workspace: string) => path.join(root(), tenant, workspace);
  return {
    kind: "files",
    put(rec) {
      const dir = dirOf(rec.tenant, rec.workspace);
      fs.mkdirSync(dir, { recursive: true });
      const name = `${Date.now().toString().padStart(14, "0")}-${String(seq++ % 1_000_000).padStart(6, "0")}-${rec.id}.json`;
      const file = path.join(dir, name);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(rec));
      fs.renameSync(`${file}.tmp`, file);
      return file;
    },
    remove(tenant, workspace, handle) {
      try {
        fs.rmSync(handle, { force: true });
        fs.rmdirSync(dirOf(tenant, workspace)); // only when empty
      } catch {
        // not empty, or already gone
      }
    },
    workspaces() {
      const out: { tenant: string; workspace: string }[] = [];
      let tenants: string[] = [];
      try {
        tenants = fs.readdirSync(root());
      } catch {
        return out;
      }
      for (const tenant of tenants) {
        try {
          for (const workspace of fs.readdirSync(path.join(root(), tenant))) out.push({ tenant, workspace });
        } catch {
          // not a directory
        }
      }
      return out;
    },
    entries(tenant, workspace) {
      const dir = dirOf(tenant, workspace);
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
      } catch {
        return [];
      }
      const out: { handle: string; ageMs: number }[] = [];
      for (const n of names) {
        const file = path.join(dir, n);
        try {
          out.push({ handle: file, ageMs: Date.now() - fs.statSync(file).mtimeMs });
        } catch {
          // gone meanwhile
        }
      }
      return out;
    },
    read(_t, _w, handle) {
      return JSON.parse(fs.readFileSync(handle, "utf8")) as JournalRecord;
    },
    setAside(_t, _w, handle) {
      fs.renameSync(handle, `${handle}.unreadable`);
    },
    sweep(tenant, workspace, olderThanMs) {
      const dir = dirOf(tenant, workspace);
      try {
        for (const n of fs.readdirSync(dir)) {
          // a write that died before its rename leaves a .tmp: nothing to replay
          if (n.endsWith(".json.tmp") && olderThanMs > 0 && Date.now() - fs.statSync(path.join(dir, n)).mtimeMs > olderThanMs) fs.rmSync(path.join(dir, n), { force: true });
        }
      } catch {
        // nothing there
      }
    },
    drop(tenant, workspace) {
      fs.rmSync(workspace === undefined ? path.join(root(), tenant) : dirOf(tenant, workspace), { recursive: true, force: true });
    },
    move(tenant, from, to) {
      const src = dirOf(tenant, from);
      if (!fs.existsSync(src)) return;
      const dest = dirOf(tenant, to);
      fs.mkdirSync(dest, { recursive: true });
      for (const n of fs.readdirSync(src)) fs.renameSync(path.join(src, n), path.join(dest, n));
      fs.rmSync(src, { recursive: true, force: true });
    },
  };
}
