// A synthetic old-style /data folder for the importer's tests: several
// accounts, a binary file, a large file, a case collision (where the disk can
// hold one), a symlink, run records and output folders, secrets with a canary
// value. Nothing here is real data.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CANARY = "CANARY-SECRET-VALUE-do-not-print";
/** Bytes that are not text: NUL, 0xff, a lone continuation byte. */
export const BINARY = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x00, 0x01, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

/** Over the importer's large-file limit (8 MiB): streamed from disk, never read whole. */
export const BIG = Buffer.alloc(9 * 1024 * 1024 + 7, "foldrun-big-file-");

const AGENT = (n: string) => `---\nname: ${n}\n---\n${n} body\n`;

/** Can this disk hold `a` and `A` as two files? (A Mac's default one cannot.) */
export function caseSensitiveDisk(dir: string): boolean {
  const a = path.join(dir, "case-probe-a");
  fs.writeFileSync(a, "1");
  try {
    return !fs.existsSync(path.join(dir, "case-probe-A"));
  } finally {
    fs.rmSync(a, { force: true });
  }
}

const put = (file: string, body: string | Buffer, mode?: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mode) fs.chmodSync(file, mode);
};

export function buildSource(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-imp-src-"));
  const w = (t: string, n: string, ...rest: string[]) => path.join(root, t, "workspaces", n, ...rest);

  // ---- acme/desk: the busy one
  put(w("acme", "desk", "AGENTS.md"), "---\nname: desk\n---\n");
  put(w("acme", "desk", "agents", "writer", "AGENTS.md"), AGENT("writer"));
  put(w("acme", "desk", "agents", "writer", ".claude", "settings.json"), "{}");
  put(w("acme", "desk", "flows", "publish.md"), "---\nname: publish\ntrigger: manual\nsteps:\n  - agent: writer\n---\n");
  put(w("acme", "desk", "memory", "notes.md"), "lower\n");
  if (caseSensitiveDisk(root)) put(w("acme", "desk", "memory", "Notes.md"), "UPPER\n");
  put(w("acme", "desk", "scripts", "run.sh"), "#!/bin/sh\necho hi\n", 0o755);
  put(w("acme", "desk", "knowledge", "logo.bin"), BINARY);
  put(w("acme", "desk", "knowledge", "big.bin"), BIG);
  put(w("acme", "desk", "state", "cursor.json"), '{"n":1}\n');
  put(w("acme", "desk", "scratch", "tmp.txt"), "not workspace content\n");
  put(w("acme", "desk", "hooks.json"), JSON.stringify({ publish: { token: CANARY } }));
  fs.symlinkSync("/etc/hosts", w("acme", "desk", "agents", "evil"));
  // runs/ on the volume: counted, never read
  put(w("acme", "desk", "runs", "run-a.json"), "{}");
  put(w("acme", "desk", "runs", "run-b.json.imported-2026-11-09"), "{}");
  put(w("acme", "desk", "runs", "run-a", "outputs", "writer", "out.txt"), "output bytes\n");
  put(w("acme", "desk", "trigger-log.jsonl.imported-2026-11-09"), "{}\n");
  put(w("acme", "desk", "secrets.json"), JSON.stringify({ A: { iv: "x", tag: "y", data: CANARY } }));
  // account level
  put(path.join(root, "acme", "storage", "desk", "index.json"), "{}");
  put(path.join(root, "acme", "secrets.json"), JSON.stringify({ ONE: { data: CANARY } }));
  put(path.join(root, "acme", "library", "agents", "helper", "AGENTS.md"), AGENT("helper"));
  put(path.join(root, "acme", ".history", "desk", "x.json"), "{}");

  // ---- acme/desk2: shares a file's bytes with desk (one blob, two workspaces)
  put(w("acme", "desk2", "AGENTS.md"), "---\nname: desk2\n---\n");
  put(w("acme", "desk2", "agents", "writer", "AGENTS.md"), AGENT("writer"));

  // ---- beta/old: a workspace under the legacy "projects" name
  put(path.join(root, "beta", "projects", "old", "AGENTS.md"), "---\nname: old\n---\n");
  put(path.join(root, "beta", "projects", "old", "skills", "s", "SKILL.md"), "---\nname: s\n---\nbody\n");

  // ---- gamma/blank: a workspace with nothing in it
  fs.mkdirSync(w("gamma", "blank"), { recursive: true });

  // ---- not accounts: ignored
  put(path.join(root, ".DS_Store"), "x");
  put(path.join(root, "Not_An_Account", "AGENTS.md"), "x");
  return root;
}

