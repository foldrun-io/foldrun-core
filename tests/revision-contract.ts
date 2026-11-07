// ONE contract suite for the revision machinery (FOL-126, phase 1).
//
// The same cases run against every BlobStore × RevisionStore pairing that
// exists: fs + local and s3(fake) + local in foldrun-core, and the pg store in
// foldrun-platform. Anything one implementation does that another does not is
// a bug in one of them, found here rather than at cutover.
//
// Not a *.test.ts file on purpose: it defines tests when `revisionContract()`
// is called from one that is.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import type { BlobStore, BlobSweeper } from "../src/blob-store.ts";
import { readAll, BlobNotFound } from "../src/blob-store.ts";
import type { RevisionStore, WorkspaceRef, Revision } from "../src/revision-store.ts";
import { publish, restore, manifestsOf, manifestsAt, headsOf, revisionFor, missingBlobs, openPath, BlobMissing, PublishError, type Deps, type PublishResult } from "../src/publish.ts";
import { OpIdReused } from "../src/revision-store.ts";
import type { BlobPins, PinHolder } from "../src/blob-pins.ts";
import { blobObjectKey, manifestObjectKey, sha256Hex, entryId, conflictPath, MODE_FILE, MODE_EXEC, type Changes } from "../src/manifest.ts";

export interface Harness {
  blobs: BlobStore & BlobSweeper;
  revisions: RevisionStore;
  cleanup(): Promise<void>;
}

const sha = (s: string) => sha256Hex(s);
let counter = 0;
const fresh = (): WorkspaceRef => ({ tenant: "default", workspace: `w${Date.now().toString(36)}${(counter++).toString(36)}${crypto.randomBytes(2).toString("hex")}` });
let opN = 0;
const op = (label = "op") => `${label}-${Date.now().toString(36)}-${(opN++).toString(36)}-${crypto.randomBytes(3).toString("hex")}`;

/** What a writer does: stage a revision, edit some paths, hand the changes in. */
async function edit(
  deps: Deps,
  ws: WorkspaceRef,
  /** What the writer staged: a workspace revision, or a publish result (both heads). */
  staged: Revision | PublishResult | null,
  edits: Record<string, string | { content: string; exec?: boolean } | null>,
  opts: { opId?: string; by?: string } = {},
): Promise<{ input: Parameters<typeof publish>[1]; blobs: Map<string, Buffer> }> {
  const base = await manifestsAt(
    deps,
    ws.tenant,
    staged && "status" in staged ? { workspace: staged.revision, state: staged.stateRevision ?? null } : { workspace: staged as Revision | null, state: null },
  );
  const bytes = new Map<string, Buffer>();
  const changes: Changes = {};
  for (const [p, v] of Object.entries(edits)) {
    const entry = base.authored.files[p] ?? base.state.files[p];
    const was = entry ? entryId(entry) : null;
    if (v === null) {
      changes[p] = { op: "delete", base: was! };
      continue;
    }
    const content = typeof v === "string" ? v : v.content;
    const exec = typeof v === "object" && v.exec;
    const buf = Buffer.from(content);
    bytes.set(sha(content), buf);
    changes[p] = { op: "put", base: was, sha: sha(content), size: buf.length, mode: exec ? MODE_EXEC : MODE_FILE };
  }
  return {
    blobs: bytes,
    input: { ws, opId: opts.opId ?? op(), by: opts.by ?? "user:test", message: "test", changes, bytesOf: async (s) => bytes.get(s)! },
  };
}

async function text(deps: Deps, ws: WorkspaceRef, rev: Revision, rel: string): Promise<string | null> {
  const o = await openPath(deps, ws.tenant, rev, rel);
  if (!o) return null;
  const chunks: Buffer[] = [];
  const reader = o.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString();
}

export function revisionContract(label: string, make: () => Promise<Harness>): void {
  const t = (name: string, fn: (h: Harness, deps: Deps) => Promise<void>) =>
    test(`[${label}] ${name}`, async () => {
      const h = await make();
      try {
        await fn(h, { blobs: h.blobs, revisions: h.revisions });
      } finally {
        await h.cleanup();
      }
    });

  // ---------- the BlobStore ----------

  t("blob: a conditional put writes once; the second says it was already there", async ({ blobs }) => {
    const key = blobObjectKey("default", sha("hello"));
    // `created` is the contract; a real store adds the object's ETag.
    assert.equal((await blobs.putIfAbsent(key, Buffer.from("hello"))).created, true);
    assert.equal((await blobs.putIfAbsent(key, Buffer.from("hello"))).created, false);
    assert.equal((await readAll(blobs, key)).toString(), "hello");
    assert.equal((await blobs.head(key))?.size, 5);
  });

  t("blob: two racing conditional puts — exactly one creates", async ({ blobs }) => {
    const key = blobObjectKey("default", sha("race"));
    const results = await Promise.all(Array.from({ length: 6 }, () => blobs.putIfAbsent(key, Buffer.from("race"))));
    assert.equal(results.filter((r) => r.created).length, 1);
  });

  t("blob: get streams a range; a missing key is BlobNotFound; delete is idempotent", async ({ blobs }) => {
    const key = blobObjectKey("default", sha("0123456789"));
    await blobs.putIfAbsent(key, Buffer.from("0123456789"));
    const part = (await blobs.get(key, { range: { start: 2, end: 4 } })).getReader();
    const { value } = await part.read();
    assert.equal(Buffer.from(value!).toString(), "234");
    await blobs.delete(key);
    await blobs.delete(key);
    assert.equal(await blobs.head(key), null);
    await assert.rejects(() => blobs.get(key), BlobNotFound);
  });

  t("blob: keys that could leave the store are refused", async ({ blobs }) => {
    for (const bad of ["../x", "/abs", "a//b", "a/./b", ""]) await assert.rejects(() => blobs.head(bad), /illegal object key/);
  });

  // ---------- the RevisionStore, on its own ----------

  t("commit: the first commit needs base null; a wrong base is stale and writes nothing", async ({ revisions }) => {
    const ws = fresh();
    const a = await revisions.commit(ws, { base: null, authored: "a".repeat(64), state: "b".repeat(64), opId: op(), digest: "d", by: "u", message: "one" });
    assert.equal(a.status, "committed");
    const stale = await revisions.commit(ws, { base: null, authored: "c".repeat(64), state: "b".repeat(64), opId: op(), digest: "d", by: "u", message: "two" });
    assert.equal(stale.status, "stale");
    assert.equal((stale as { head: Revision }).head.id, (a as { revision: Revision }).revision.id);
    assert.equal((await revisions.revisions(ws)).length, 1);
    assert.equal((await revisions.head(ws))?.seq, 1);
  });

  t("commit: the same op id twice is a duplicate of the first, never a second revision", async ({ revisions }) => {
    const ws = fresh();
    const id = op();
    const a = await revisions.commit(ws, { base: null, authored: "a".repeat(64), state: "b".repeat(64), opId: id, digest: "d", by: "u", message: "one" });
    const again = await revisions.commit(ws, { base: null, authored: "a".repeat(64), state: "b".repeat(64), opId: id, digest: "d", by: "u", message: "one" });
    assert.equal(again.status, "duplicate");
    assert.equal((again as { revision: Revision }).revision.id, (a as { revision: Revision }).revision.id);
    // even after the head moved on:
    const b = await revisions.commit(ws, { base: (a as { revision: Revision }).revision.id, authored: "c".repeat(64), state: "b".repeat(64), opId: op(), digest: "d", by: "u", message: "two" });
    assert.equal(b.status, "committed");
    assert.equal((await revisions.commit(ws, { base: null, authored: "a".repeat(64), state: "b".repeat(64), opId: id, digest: "d", by: "u", message: "one" })).status, "duplicate");
    assert.equal((await revisions.revisions(ws)).length, 2);
  });

  t("commit: many writers from one head — exactly one wins each round, none lost, history is a line", async ({ revisions }) => {
    const ws = fresh();
    const first = (await revisions.commit(ws, { base: null, authored: "0".repeat(64), state: "0".repeat(64), opId: op(), digest: "d", by: "u", message: "root" })) as { revision: Revision };
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        revisions.commit(ws, { base: first.revision.id, authored: String(i).repeat(64), state: "0".repeat(64), opId: op(), digest: "d", by: `u${i}`, message: "x" }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "committed").length, 1);
    assert.equal(results.filter((r) => r.status === "stale").length, 7);
    const all = await revisions.revisions(ws);
    assert.deepEqual(all.map((r) => r.seq), [2, 1]);
    assert.equal(all[0].parent, all[1].id);
  });

  t("revisions: newest first, paged by seq", async ({ revisions }) => {
    const ws = fresh();
    let base: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r = (await revisions.commit(ws, { base, authored: String(i).repeat(64), state: "0".repeat(64), opId: op(), digest: "d", by: "u", message: `m${i}` })) as { revision: Revision };
      base = r.revision.id;
    }
    const page1 = await revisions.revisions(ws, { limit: 2 });
    assert.deepEqual(page1.map((r) => r.seq), [5, 4]);
    const page2 = await revisions.revisions(ws, { limit: 2, before: page1[1].seq });
    assert.deepEqual(page2.map((r) => r.seq), [3, 2]);
    assert.equal((await revisions.revision(ws, page2[0].id))?.seq, 3);
    assert.equal(await revisions.revision(ws, "rev_nope"), null);
  });

  t("file index: rows are independent; expectations guard each row", async ({ revisions }) => {
    const ws = fresh();
    const row = (p: string, s: string) => ({ path: p, sha: s.repeat(64), size: 3, mime: "text/plain", updatedAt: new Date().toISOString(), by: "user:t" });
    await Promise.all(Array.from({ length: 12 }, (_, i) => revisions.putFile(ws, row(`f${i}.txt`, "a"))));
    assert.equal((await revisions.files(ws)).length, 12);
    assert.equal(await revisions.putFile(ws, row("f0.txt", "b"), null), false, "expects no row, but there is one");
    assert.equal(await revisions.putFile(ws, row("f0.txt", "b"), "z".repeat(64)), false, "expects another sha");
    assert.equal(await revisions.putFile(ws, row("f0.txt", "b"), "a".repeat(64)), true);
    assert.equal((await revisions.files(ws)).find((f) => f.path === "f0.txt")?.sha, "b".repeat(64));
    assert.equal(await revisions.deleteFile(ws, "f0.txt", "a".repeat(64)), false, "the row moved on");
    assert.equal(await revisions.deleteFile(ws, "f0.txt", "b".repeat(64)), true);
    assert.equal(await revisions.deleteFile(ws, "f0.txt"), false, "already gone");
    assert.equal((await revisions.files(ws)).length, 11);
  });

  // ---------- the protocol ----------

  t("publish: the first publish creates the workspace's first revision, with modes", async (_h, deps) => {
    const ws = fresh();
    const w = await edit(deps, ws, null, { "AGENTS.md": "# hi", "scripts/run.sh": { content: "#!/bin/sh\n", exec: true }, "state/notes.md": "n" });
    const r = await publish(deps, w.input);
    assert.equal(r.status, "committed");
    const { authored, state } = await manifestsAt(deps, ws.tenant, await headsOf(deps, ws));
    assert.deepEqual(Object.keys(authored.files).sort(), ["AGENTS.md", "scripts/run.sh"]);
    assert.equal(authored.files["scripts/run.sh"].mode, MODE_EXEC);
    assert.deepEqual(Object.keys(state.files), ["state/notes.md"]);
    // two heads: source on one, state/ on the other, each its own history
    const heads = await headsOf(deps, ws);
    assert.equal(heads.workspace?.scope, "workspace");
    assert.equal(heads.state?.scope, "state");
    assert.equal((r as { stateRevision?: Revision | null }).stateRevision?.id, heads.state?.id);
    assert.equal(heads.workspace?.seq, 1);
    assert.equal(heads.state?.seq, 1);
  });

  t("publish: a path outside workspace content is refused before anything is uploaded", async (_h, deps) => {
    const ws = fresh();
    for (const bad of ["storage/x.csv", "runs/r1/out", "../etc/passwd", "agents\\x.md", "/agents/x.md", "secrets.json"]) {
      const w = await edit(deps, ws, null, { [bad]: "x" }).catch(() => null);
      if (w) await assert.rejects(() => publish(deps, w.input), /illegal manifest path|not workspace content/);
    }
    assert.equal(await deps.revisions.head(ws), null);
  });

  t("concurrent commit: writers of DIFFERENT paths, all staged on one base, all land", async (_h, deps) => {
    const ws = fresh();
    const root = (await publish(deps, (await edit(deps, ws, null, { "memory/seed.md": "seed" })).input)) as { revision: Revision };
    const writers = await Promise.all(Array.from({ length: 6 }, (_, i) => edit(deps, ws, root.revision, { [`memory/m${i}.md`]: `note ${i}` })));
    const results = await Promise.all(writers.map((w) => publish(deps, w.input)));
    assert.ok(results.every((r) => r.status === "committed" && r.conflicts.length === 0), JSON.stringify(results.map((r) => r.status)));
    const head = (await deps.revisions.head(ws))!;
    assert.equal(head.seq, 7);
    const { authored } = await manifestsOf(deps, ws.tenant, head);
    assert.deepEqual(Object.keys(authored.files).sort(), ["memory/m0.md", "memory/m1.md", "memory/m2.md", "memory/m3.md", "memory/m4.md", "memory/m5.md", "memory/seed.md"]);
    for (let i = 0; i < 6; i++) assert.equal(await text(deps, ws, head, `memory/m${i}.md`), `note ${i}`);
  });

  t("same-path conflict: the head's version stays, the other is kept beside it, and the result says so", async (_h, deps) => {
    const ws = fresh();
    const root = (await publish(deps, (await edit(deps, ws, null, { "memory/log.md": "start" })).input)) as { revision: Revision };
    const a = await edit(deps, ws, root.revision, { "memory/log.md": "from A" });
    const b = await edit(deps, ws, root.revision, { "memory/log.md": "from B" });
    const ra = await publish(deps, a.input);
    const rb = await publish(deps, b.input);
    assert.equal(ra.status, "committed");
    assert.equal(rb.status, "committed");
    assert.equal(rb.conflicts.length, 1);
    assert.equal(rb.conflicts[0].path, "memory/log.md");
    const head = (await deps.revisions.head(ws))!;
    assert.equal(await text(deps, ws, head, "memory/log.md"), "from A");
    assert.equal(await text(deps, ws, head, rb.conflicts[0].keptAs!), "from B");
    assert.deepEqual(head.conflicts, ["memory/log.md"]);
  });

  t("same-path conflict: a delete against a changed file keeps the change", async (_h, deps) => {
    const ws = fresh();
    const root = (await publish(deps, (await edit(deps, ws, null, { "tools/t.md": "v1" })).input)) as { revision: Revision };
    const edited = await edit(deps, ws, root.revision, { "tools/t.md": "v2" });
    const deleted = await edit(deps, ws, root.revision, { "tools/t.md": null });
    await publish(deps, edited.input);
    const r = await publish(deps, deleted.input);
    assert.deepEqual(r.conflicts, [{ path: "tools/t.md", keptAs: null }]);
    assert.equal(await text(deps, ws, (await deps.revisions.head(ws))!, "tools/t.md"), "v2");
  });

  t("two writers making the SAME change is not a conflict", async (_h, deps) => {
    const ws = fresh();
    const root = (await publish(deps, (await edit(deps, ws, null, { "memory/a.md": "1" })).input)) as { revision: Revision };
    const a = await edit(deps, ws, root.revision, { "memory/a.md": "2" });
    const b = await edit(deps, ws, root.revision, { "memory/a.md": "2" });
    await publish(deps, a.input);
    const r = await publish(deps, b.input);
    assert.equal(r.status, "unchanged");
    assert.equal(r.conflicts.length, 0);
    assert.equal((await deps.revisions.head(ws))!.seq, 2);
  });

  t("crash between upload and commit: the old head stands, orphans are harmless, the retry commits once", async ({ blobs, revisions }) => {
    const ws = fresh();
    const root = (await publish({ blobs, revisions }, (await edit({ blobs, revisions }, ws, null, { "memory/a.md": "one" })).input)) as { revision: Revision };
    const w = await edit({ blobs, revisions }, ws, root.revision, { "memory/a.md": "two", "memory/b.md": "new" });
    // A store whose commit dies: the worker was killed after uploading.
    const crashing: RevisionStore = { ...revisions, commit: async () => { throw new Error("worker killed"); } };
    await assert.rejects(() => publish({ blobs, revisions: crashing }, w.input), /worker killed/);
    assert.equal((await revisions.head(ws))!.id, root.revision.id, "the head did not move");
    assert.ok(await blobs.head(blobObjectKey(ws.tenant, sha("two"))), "the orphan blob is there, unreferenced");
    // The retry (same op id) lands exactly once, and a second retry is a duplicate.
    const r = await publish({ blobs, revisions }, w.input);
    assert.equal(r.status, "committed");
    assert.equal((await publish({ blobs, revisions }, w.input)).status, "duplicate");
    assert.equal((await revisions.revisions(ws)).length, 2);
    assert.equal(await text({ blobs, revisions }, ws, (await revisions.head(ws))!, "memory/a.md"), "two");
  });

  t("ambiguous retry: the commit landed but its answer was lost — the retry is a duplicate, not a second revision", async ({ blobs, revisions }) => {
    const ws = fresh();
    const deps = { blobs, revisions };
    const w = await edit(deps, ws, null, { "memory/a.md": "x" });
    const lossy: RevisionStore = {
      ...revisions,
      commit: async (...args) => {
        await revisions.commit(...args); // it happened…
        throw new Error("connection reset"); // …and we never heard
      },
    };
    await assert.rejects(() => publish({ blobs, revisions: lossy }, w.input), /connection reset/);
    const retry = await publish(deps, w.input);
    assert.equal(retry.status, "duplicate");
    assert.equal((await revisions.revisions(ws)).length, 1);
    // …and a retry racing its own twin still makes one.
    const w2 = await edit(deps, ws, (await revisions.head(ws))!, { "memory/b.md": "y" });
    const twins = await Promise.all([publish(deps, w2.input), publish(deps, w2.input), publish(deps, w2.input)]);
    assert.equal(twins.filter((r) => r.status === "committed").length, 1);
    assert.equal((await revisions.revisions(ws)).length, 2);
  });

  t("delete racing a publish: a blob swept after the upload is put back before the commit", async ({ blobs, revisions }) => {
    const ws = fresh();
    const w = await edit({ blobs, revisions }, ws, null, { "memory/a.md": "precious" });
    const key = blobObjectKey(ws.tenant, sha("precious"));
    let swept = false;
    // The garbage collector deletes the (still unreferenced) blob right after
    // publish's upload, as publish asks for the head.
    const sweeping: RevisionStore = {
      ...revisions,
      head: async (x) => {
        if (!swept) {
          swept = true;
          await blobs.delete(key);
        }
        return revisions.head(x);
      },
    };
    const r = await publish({ blobs, revisions: sweeping }, w.input);
    assert.equal(r.status, "committed");
    assert.ok(swept);
    assert.equal(await text({ blobs, revisions }, ws, (r as { revision: Revision }).revision, "memory/a.md"), "precious");
    assert.deepEqual(await missingBlobs({ blobs, revisions }, ws.tenant, (r as { revision: Revision }).revision), []);
  });

  t("missing blob: reading says which file and which hash, restore refuses, nothing moves", async ({ blobs, revisions }) => {
    const ws = fresh();
    const deps = { blobs, revisions };
    const r1 = (await publish(deps, (await edit(deps, ws, null, { "memory/a.md": "gone soon", "memory/b.md": "fine" })).input)) as { revision: Revision };
    const r2 = (await publish(deps, (await edit(deps, ws, r1.revision, { "memory/c.md": "later" })).input)) as { revision: Revision };
    await blobs.delete(blobObjectKey(ws.tenant, sha("gone soon")));
    await assert.rejects(() => text(deps, ws, r1.revision, "memory/a.md"), (e: unknown) => e instanceof BlobMissing && e.path === "memory/a.md");
    assert.equal(await text(deps, ws, r1.revision, "memory/b.md"), "fine");
    assert.deepEqual((await missingBlobs(deps, ws.tenant, r1.revision)).map((m) => m.path), ["memory/a.md"]);
    await assert.rejects(() => restore(deps, { ws, to: r1.revision.id, opId: op(), by: "user:t" }), BlobMissing);
    assert.equal((await revisions.head(ws))!.id, r2.revision.id, "a refused restore changes nothing");
    // a manifest that is gone is a missing blob too, not an empty workspace
    await blobs.delete(manifestObjectKey(ws.tenant, r2.revision.authored));
    await assert.rejects(() => manifestsOf(deps, ws.tenant, r2.revision), BlobMissing);
  });

  t("restore: a NEW revision pointing at old content; history is kept; state/ stays unless asked", async (_h, deps) => {
    const ws = fresh();
    const r1 = await publish(deps, (await edit(deps, ws, null, { "agents/a/agent.md": "v1", "state/s.json": "s1" })).input);
    const r2 = await publish(deps, (await edit(deps, ws, r1, { "agents/a/agent.md": "v2", "state/s.json": "s2" })).input);
    const back = await restore(deps, { ws, to: r1.revision!.id, opId: op(), by: "user:t" });
    assert.equal(back.status, "committed");
    const rev = (back as { revision: Revision }).revision;
    assert.equal(rev.seq, 3);
    assert.equal(rev.parent, r2.revision!.id);
    assert.equal(rev.restoredFrom, r1.revision!.id);
    assert.equal(await text(deps, ws, rev, "agents/a/agent.md"), "v1");
    const heads = await headsOf(deps, ws);
    assert.equal(await text(deps, ws, revisionFor(heads, "state/s.json")!, "state/s.json"), "s2", "state was not rewound");
    assert.deepEqual((await deps.revisions.revisions(ws)).map((r) => r.seq), [3, 2, 1], "nothing was rewritten");
    assert.deepEqual((await deps.revisions.revisions({ ...ws, scope: "state" })).map((r) => r.seq), [2, 1], "the state head did not move");
    assert.equal(await text(deps, ws, r2.revision!, "agents/a/agent.md"), "v2", "the revision restored from is still readable");
    // explicit state rewind: name a state revision
    const both = await restore(deps, { ws, to: r1.revision!.id, opId: op(), by: "user:t", stateTo: r1.stateRevision!.id });
    assert.equal(both.status, "committed");
    const after = await headsOf(deps, ws);
    assert.equal(await text(deps, ws, after.state!, "state/s.json"), "s1");
    assert.equal(after.state!.restoredFrom, r1.stateRevision!.id);
    assert.equal(after.state!.seq, 3);
    // retried restore is a duplicate
    const id = op();
    await restore(deps, { ws, to: r2.revision.id, opId: id, by: "user:t" });
    assert.equal((await restore(deps, { ws, to: r2.revision.id, opId: id, by: "user:t" })).status, "duplicate");
  });

  t("restore to what the head already is makes no revision", async (_h, deps) => {
    const ws = fresh();
    const r1 = (await publish(deps, (await edit(deps, ws, null, { "memory/a.md": "x" })).input)) as { revision: Revision };
    const again = await restore(deps, { ws, to: r1.revision.id, opId: op(), by: "user:t" });
    assert.equal(again.status, "unchanged");
    assert.equal((await deps.revisions.revisions(ws)).length, 1);
  });

  t("an unchanged publish makes no revision and uploads nothing new", async ({ blobs, revisions }) => {
    const ws = fresh();
    const deps = { blobs, revisions };
    const r1 = (await publish(deps, (await edit(deps, ws, null, { "memory/a.md": "same" })).input)) as { revision: Revision };
    const w = await edit(deps, ws, r1.revision, { "memory/a.md": "same" });
    const r = await publish(deps, w.input);
    assert.equal(r.status, "unchanged");
    assert.equal((await revisions.revisions(ws)).length, 1);
  });

  t("a bad hash in the supplied bytes is refused", async (_h, deps) => {
    const ws = fresh();
    const w = await edit(deps, ws, null, { "memory/a.md": "honest" });
    await assert.rejects(() => publish(deps, { ...w.input, bytesOf: async () => Buffer.from("not what was promised") }), /do not hash/);
    assert.equal(await deps.revisions.head(ws), null);
  });

  // ---------- found by the Codex review (6 Nov 2026) ----------

  t("a mode-only change (chmod +x, same bytes) is published, not dropped as 'unchanged'", async (_h, deps) => {
    const ws = fresh();
    const r1 = (await publish(deps, (await edit(deps, ws, null, { "scripts/run.sh": "#!/bin/sh\n" })).input)) as { revision: Revision };
    const w = await edit(deps, ws, r1.revision, { "scripts/run.sh": { content: "#!/bin/sh\n", exec: true } });
    const r = await publish(deps, w.input);
    assert.equal(r.status, "committed");
    const { authored } = await manifestsOf(deps, ws.tenant, (r as { revision: Revision }).revision);
    assert.equal(authored.files["scripts/run.sh"].mode, MODE_EXEC);
  });

  t("an op id reused for a DIFFERENT request is refused, not answered with the first one's revision", async (_h, deps) => {
    const ws = fresh();
    const id = op();
    const a = await edit(deps, ws, null, { "memory/a.md": "first" }, { opId: id });
    await publish(deps, a.input);
    const b = await edit(deps, ws, null, { "memory/a.md": "something else" }, { opId: id });
    await assert.rejects(() => publish(deps, b.input), OpIdReused);
    // …while the same request again is the retry it looks like
    assert.equal((await publish(deps, a.input)).status, "duplicate");
    assert.equal((await deps.revisions.revisions(ws)).length, 1);
    // a restore reusing a publish's op id is a different request too
    const headId = (await deps.revisions.head(ws))!.id;
    await assert.rejects(() => restore(deps, { ws, to: headId, opId: id, by: "user:t" }), OpIdReused);
  });

  t("a no-op publish is recorded: retried after the head moved, it still answers 'unchanged', not a late revision", async (_h, deps) => {
    const ws = fresh();
    const r1 = (await publish(deps, (await edit(deps, ws, null, { "memory/a.md": "same" })).input)) as { revision: Revision };
    const noop = await edit(deps, ws, r1.revision, { "memory/a.md": "same" });
    assert.equal((await publish(deps, noop.input)).status, "unchanged");
    assert.equal((await deps.revisions.operation(ws, noop.input.opId))?.outcome, "unchanged");
    // the head moves on…
    await publish(deps, (await edit(deps, ws, r1.revision, { "memory/a.md": "changed later" })).input);
    // …and the lost-answer retry of the no-op must not now turn into a revision
    assert.equal((await publish(deps, noop.input)).status, "unchanged");
    assert.equal(await text(deps, ws, (await deps.revisions.head(ws))!, "memory/a.md"), "changed later");
    assert.equal((await deps.revisions.revisions(ws)).length, 2);
  });

  t("a conflict on a ROOT file (AGENTS.md) keeps the other version under a legal root name, and the revision reads back", async (_h, deps) => {
    const ws = fresh();
    const root = (await publish(deps, (await edit(deps, ws, null, { "AGENTS.md": "# base" })).input)) as { revision: Revision };
    await publish(deps, (await edit(deps, ws, root.revision, { "AGENTS.md": "# from A" })).input);
    const rb = await publish(deps, (await edit(deps, ws, root.revision, { "AGENTS.md": "# from B" })).input);
    assert.equal(rb.conflicts.length, 1);
    const head = (await deps.revisions.head(ws))!;
    await manifestsOf(deps, ws.tenant, head); // parses: every path in it is legal
    assert.equal(await text(deps, ws, head, "AGENTS.md"), "# from A");
    assert.equal(await text(deps, ws, head, rb.conflicts[0].keptAs!), "# from B");
  });

  t("a conflict copy never lands on a name something else already holds", async (_h, deps) => {
    const ws = fresh();
    const opB = op("b");
    const squat = conflictPath("memory/log.md", opB); // a person already has a file by that name
    const root = (await publish(deps, (await edit(deps, ws, null, { "memory/log.md": "start", [squat]: "unrelated notes" })).input)) as { revision: Revision };
    await publish(deps, (await edit(deps, ws, root.revision, { "memory/log.md": "from A" })).input);
    const rb = await publish(deps, (await edit(deps, ws, root.revision, { "memory/log.md": "from B" }, { opId: opB })).input);
    const head = (await deps.revisions.head(ws))!;
    assert.equal(await text(deps, ws, head, squat), "unrelated notes", "the squatter is untouched");
    assert.notEqual(rb.conflicts[0].keptAs, squat);
    assert.equal(await text(deps, ws, head, rb.conflicts[0].keptAs!), "from B");
  });

  t("malformed changes are refused before anything is uploaded or committed", async (_h, deps) => {
    const ws = fresh();
    const w = await edit(deps, ws, null, { "memory/a.md": "x" });
    const put = Object.values(w.input.changes)[0] as { mode: number; size: number; base: string | null };
    for (const bad of [{ mode: 0o777 }, { size: -1 }, { base: "not-an-entry-id" }, { size: 999 }]) {
      const changes = { "memory/a.md": { ...put, ...bad } } as Changes;
      await assert.rejects(() => publish(deps, { ...w.input, changes, opId: op() }), PublishError);
    }
    assert.equal(await deps.revisions.head(ws), null);
    assert.equal(await deps.blobs.head(blobObjectKey(ws.tenant, sha("x"))), null, "nothing was uploaded for a refused change");
  });

  t("a declared size that disagrees with a blob already in the store is refused", async ({ blobs, revisions }) => {
    const ws = fresh();
    const deps = { blobs, revisions };
    await blobs.putIfAbsent(blobObjectKey(ws.tenant, sha("hello")), Buffer.from("hello"));
    const w = await edit(deps, ws, null, { "memory/a.md": "hello" });
    const c = w.input.changes["memory/a.md"] as { size: number };
    c.size = 99;
    await assert.rejects(() => publish(deps, w.input), /stored with 5 bytes/);
  });

  t("a manifest whose stored bytes are not what its name says is corruption, not a workspace", async ({ blobs, revisions }) => {
    const ws = fresh();
    const deps = { blobs, revisions };
    const r1 = (await publish(deps, (await edit(deps, ws, null, { "memory/a.md": "x" })).input)) as { revision: Revision };
    const key = manifestObjectKey(ws.tenant, r1.revision.authored);
    await blobs.delete(key);
    await blobs.putIfAbsent(key, Buffer.from('{"v":1,"files":{}}'));
    await assert.rejects(() => manifestsOf(deps, ws.tenant, r1.revision), /corrupt/);
  });

  t("restoring source is not blocked by missing HISTORICAL state it would not reference", async ({ blobs, revisions }) => {
    const ws = fresh();
    const deps = { blobs, revisions };
    const r1 = await publish(deps, (await edit(deps, ws, null, { "agents/a/agent.md": "v1", "state/s.json": "old state" })).input);
    await publish(deps, (await edit(deps, ws, r1, { "agents/a/agent.md": "v2", "state/s.json": "new state" })).input);
    await blobs.delete(blobObjectKey(ws.tenant, sha("old state"))); // r1's state is gone
    const back = await restore(deps, { ws, to: r1.revision!.id, opId: op(), by: "user:t" });
    assert.equal(back.status, "committed");
    assert.equal(await text(deps, ws, (back as { revision: Revision }).revision, "agents/a/agent.md"), "v1");
    await assert.rejects(() => restore(deps, { ws, to: r1.revision!.id, opId: op(), by: "user:t", stateTo: r1.stateRevision!.id }), BlobMissing);
    // …and a refused state rewind moved neither head
    assert.equal((await deps.revisions.head(ws))!.seq, 3);
    assert.equal((await deps.revisions.head({ ...ws, scope: "state" }))!.seq, 2);
  });

  t("a case-only collision or non-NFC name is refused", async (_h, deps) => {
    const ws = fresh();
    const root = (await publish(deps, (await edit(deps, ws, null, { "memory/Notes.md": "a" })).input)) as { revision: Revision };
    await assert.rejects(() => edit(deps, ws, root.revision, { "memory/notes.md": "b" }).then((w) => publish(deps, w.input)), /differ only by case/);
    await assert.rejects(() => edit(deps, ws, root.revision, { "memory/cafe\u0301.md": "c" }).then((w) => publish(deps, w.input)), /NFC/);
    assert.equal((await deps.revisions.head(ws))!.id, root.revision.id);
  });
  // ---------- two heads ----------

  t("two heads: state checkpoints and source saves never make each other stale", async (_h, deps) => {
    const ws = fresh();
    const r0 = await publish(deps, (await edit(deps, ws, null, { "memory/a.md": "1", "state/s.json": "0" })).input);
    // A source writer and 5 state writers all start from r0.
    const src = await edit(deps, ws, r0, { "memory/a.md": "2" });
    const sts = await Promise.all(Array.from({ length: 5 }, (_, i) => edit(deps, ws, r0, { [`state/c${i}.json`]: String(i) })));
    const results = await Promise.all([publish(deps, src.input), ...sts.map((w) => publish(deps, w.input))]);
    for (const r of results) assert.equal(r.status, "committed");
    const heads = await headsOf(deps, ws);
    assert.equal(heads.workspace!.seq, 2, "the source head moved once");
    assert.equal(heads.state!.seq, 6, "the state head moved five times");
    const { authored, state } = await manifestsAt(deps, ws.tenant, heads);
    assert.equal(Object.keys(authored.files).length, 1);
    assert.equal(Object.keys(state.files).length, 6);
  });

  t("two heads: a crash between the source commit and the state commit is finished by retrying the same call", async ({ blobs, revisions }) => {
    const ws = fresh();
    let armed = true;
    const flaky: RevisionStore = {
      ...revisions,
      commit: async (w, input) => {
        if (w.scope === "state" && armed) {
          armed = false;
          throw new Error("worker died");
        }
        return revisions.commit(w, input);
      },
    };
    const w = await edit({ blobs, revisions }, ws, null, { "agents/a/agent.md": "v1", "state/s.json": "s1" });
    await assert.rejects(() => publish({ blobs, revisions: flaky }, w.input), /worker died/);
    assert.ok(await revisions.head(ws), "the source half landed");
    assert.equal(await revisions.head({ ...ws, scope: "state" }), null, "the state half did not");
    const again = await publish({ blobs, revisions }, w.input);
    assert.equal(again.status, "committed", "the state half committed on the retry");
    assert.equal((await revisions.head(ws))!.seq, 1, "the source half was not published twice");
    assert.equal((await revisions.head({ ...ws, scope: "state" }))!.seq, 1);
    const third = await publish({ blobs, revisions }, w.input);
    assert.equal(third.status, "duplicate");
  });

  // ---------- pins ----------

  t("pins: a publish pins its blobs BEFORE it looks for them and lets go after the commit", async ({ blobs, revisions }) => {
    const ws = fresh();
    const log: string[] = [];
    const pins: BlobPins = {
      async pinBlobs(_t, shas, h: PinHolder) {
        log.push(`pin:${h.kind}:${shas.length}`);
      },
      async pinManifests() {},
      async release(_t, h) {
        log.push(`release:${h.kind}`);
        return 1;
      },
      async renew() {
        return 0;
      },
      async isPinned() {
        return false;
      },
      async guardDelete(_t, _k, _r, del) {
        await del();
        return true;
      },
    };
    const watched: BlobStore & BlobSweeper = Object.assign(Object.create(blobs), {
      head: (k: string) => {
        log.push("head");
        return blobs.head(k);
      },
      putIfAbsent: (k: string, b: Uint8Array, o?: never) => {
        log.push("put");
        return blobs.putIfAbsent(k, b, o);
      },
    });
    const deps = { blobs: watched, revisions, pins };
    const w = await edit(deps, ws, null, { "memory/a.md": "pinned", "state/s.json": "also pinned" });
    log.length = 0;
    await publish(deps, w.input);
    assert.equal(log[0], "pin:publish:2", "pinned before anything touched the store");
    assert.equal(log[log.length - 1], "release:publish", "released after the commits");
    assert.ok(log.indexOf("put") > 0 && log.indexOf("head") > 0);
    // a refused publish lets go too
    const bad = await edit(deps, ws, null, { "memory/b.md": "lost" });
    log.length = 0;
    await assert.rejects(() => publish(deps, { ...bad.input, bytesOf: async () => Buffer.from("not what was promised") }), PublishError);
    assert.equal(log[log.length - 1], "release:publish");
  });

}
