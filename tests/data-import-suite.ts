// The importer's tests (src/data-import.ts), written once and run against
// every destination that exists: fs blobs + local revisions in foldrun-core,
// Postgres in foldrun-platform. Not a *.test.ts file: callers pass a harness.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { scanSource, runImport, verifyImport, planImport, renderPlan, renderVerify, writeVerifyReport, LARGE_FILE_BYTES } from "../src/data-import.ts";
import { headsOf, manifestsAt, publish, type Deps } from "../src/publish.ts";
import { blobObjectKey, sha256Hex, MODE_EXEC } from "../src/manifest.ts";
import type { BlobSweeper } from "../src/blob-store.ts";
import { buildSource, BINARY, BIG, CANARY } from "./data-import-fixture.ts";

export interface ImportHarness {
  deps: Deps & { blobs: Deps["blobs"] & Partial<BlobSweeper> };
  cleanup(): Promise<void>;
}

/** path → sha of every file under a folder, to prove a run left it alone. */
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[path.relative(root, p)] = `link:${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) walk(p);
      else out[path.relative(root, p)] = `${sha256Hex(fs.readFileSync(p))}:${st.mode.toString(8)}:${st.mtimeMs}`;
    }
  };
  walk(root);
  return out;
}

export function dataImportSuite(label: string, make: () => Promise<ImportHarness>): void {
  const withHarness = (name: string, fn: (h: ImportHarness, src: string, out: string) => Promise<void>) =>
    test(`${label}: ${name}`, async () => {
      const h = await make();
      const src = buildSource();
      const out = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-imp-out-"));
      try {
        await fn(h, src, out);
      } finally {
        await h.cleanup();
        fs.rmSync(src, { recursive: true, force: true });
        fs.rmSync(out, { recursive: true, force: true });
      }
    });

  withHarness("a dry run reads the folder, writes nothing anywhere, and says what it can't map", async (h, src) => {
    const before = snapshot(src);
    const scan = await scanSource({ source: src });
    const plan = await planImport(scan, h.deps);
    const text = renderPlan(scan, plan);
    assert.deepEqual(snapshot(src), before, "the source folder is untouched");
    assert.equal(await h.deps.revisions.head({ tenant: "acme", workspace: "desk" }), null, "nothing was written to the destination");

    const acme = scan.tenants.find((t) => t.tenant === "acme")!;
    const desk = acme.workspaces.find((w) => w.workspace === "desk")!;
    assert.ok(desk.files.some((f) => f.path === "knowledge/logo.bin" && f.size === BINARY.length), "the binary file is counted");
    assert.ok(desk.files.some((f) => f.path === "knowledge/big.bin" && f.size === BIG.length && f.size > LARGE_FILE_BYTES), "the large file is counted");
    assert.equal(desk.files.find((f) => f.path === "scripts/run.sh")!.mode, MODE_EXEC);
    const caseDisk = desk.files.some((f) => f.path === "memory/Notes.md");
    assert.equal(desk.conflicts.length, caseDisk ? 1 : 0, "a case-colliding name is a conflict copy (where the disk can hold the pair)");
    assert.ok(desk.unmapped.some((u) => u.path === "agents/evil" && /symbolic link/.test(u.reason)), "a symlink is refused, not followed");
    assert.ok(desk.unmapped.some((u) => u.path === "scratch"), "an unknown top-level folder is reported");
    assert.ok(desk.unmapped.some((u) => u.path === "hooks.json"));
    assert.ok(desk.unmapped.some((u) => u.path === "secrets.json" && /never opened/.test(u.reason)), "secrets are named, not opened");
    assert.ok(desk.unmapped.some((u) => u.path === "trigger-log.jsonl.imported-2026-11-09"), "a set-aside trigger log is reported, not read");
    assert.deepEqual(desk.runs, { recordFiles: 2, outputFolders: 1, outputFiles: 1, outputBytes: "output bytes\n".length }, "runs/ is counted, never read");
    assert.ok(!desk.files.some((f) => f.path.includes(".claude")), "engine home files are not workspace content");
    for (const p of ["storage", "secrets.json", "library", ".history"]) assert.ok(acme.unmapped.some((u) => u.path === p), `account-level ${p} is reported`);

    const legacy = scan.tenants.find((t) => t.tenant === "beta")!;
    assert.deepEqual(legacy.workspaces.map((w) => w.workspace), ["old"], "a workspace under the legacy projects/ name is found");
    assert.ok(text.startsWith("DRY RUN — nothing was written."));
    assert.ok(text.includes("acme") && text.includes("beta") && text.includes("gamma"));
    assert.ok(!text.includes(CANARY) && !JSON.stringify(scan).includes(CANARY), "a secret's value never appears");
  });

  withHarness("an import publishes every workspace, and verify passes by path, sha256 and mode", async (h, src, out) => {
    const before = snapshot(src);
    const scan = await scanSource({ source: src });
    const report = await runImport(scan, { deps: h.deps });
    assert.deepEqual(report.results.map((r) => `${r.tenant}/${r.workspace}:${r.status}`), ["acme/desk:imported", "acme/desk2:imported", "beta/old:imported", "gamma/blank:empty"]);
    assert.equal(report.results[0].filesStreamed, 1, "the large file went up from disk");

    const heads = await headsOf(h.deps, { tenant: "acme", workspace: "desk" });
    const m = await manifestsAt(h.deps, "acme", heads);
    const all = { ...m.authored.files, ...m.state.files };
    assert.equal(all["knowledge/logo.bin"].sha, sha256Hex(BINARY), "binary bytes are the same bytes");
    assert.equal(all["knowledge/big.bin"].sha, sha256Hex(BIG), "so are a large file's");
    assert.equal(all["scripts/run.sh"].mode, MODE_EXEC);
    assert.ok(all["state/cursor.json"], "state/ is on its own head");
    assert.ok(heads.state, "state head exists");
    if (scan.tenants[0].workspaces[0].conflicts.length) assert.ok(Object.keys(all).some((p) => /^memory\/notes\.conflict-[0-9a-f]{12}\.md$/.test(p)), "both case variants are kept");
    assert.ok(!Object.keys(all).some((p) => p.includes("evil") || p.includes("scratch") || p.includes("hooks.json") || p.includes("secrets")));
    assert.equal((await h.deps.revisions.revisions({ tenant: "acme", workspace: "desk" }))[0].by, "import:data-folder");

    const v = await verifyImport(scan, { deps: h.deps, deep: true });
    assert.equal(v.pass, true, renderVerify(v));
    assert.equal(v.workspaces.length, 4);
    const files = writeVerifyReport(out, src, v);
    assert.equal(JSON.parse(fs.readFileSync(files.json, "utf8")).pass, true);
    const txt = fs.readFileSync(files.txt, "utf8");
    assert.match(txt, /PASSED/);
    assert.ok(!txt.includes(CANARY) && !fs.readFileSync(files.json, "utf8").includes(CANARY));
    assert.throws(() => writeVerifyReport(path.join(src, "acme", "reports"), src, v), /outside the source/);
    assert.deepEqual(snapshot(src), before, "the source folder is untouched, byte for byte and mode for mode");
  });

  withHarness("a large file is streamed from disk, never handed to the store as one buffer", async (h, src) => {
    const inner = h.deps.blobs;
    const bigKey = blobObjectKey("acme", sha256Hex(BIG));
    const calls: string[] = [];
    const spy: Deps = {
      ...h.deps,
      blobs: {
        ...inner,
        kind: inner.kind,
        head: (k, o) => inner.head(k, o),
        get: (k, o) => inner.get(k, o),
        putIfAbsent: async (k, b, o) => {
          calls.push(`buffer:${k === bigKey ? "big" : "small"}`);
          return inner.putIfAbsent(k, b, o);
        },
        putSourceIfAbsent: async (k, s, o) => {
          calls.push(`source:${k === bigKey ? "big" : "small"}`);
          return inner.putSourceIfAbsent(k, s, o);
        },
      },
    };
    await runImport(await scanSource({ source: src, workspaces: ["acme/desk"] }), { deps: spy });
    assert.ok(calls.includes("source:big"), "streamed");
    assert.ok(!calls.includes("buffer:big"), "never as a buffer");
    assert.ok(calls.includes("buffer:small"), "small files still go the plain way");
  });

  withHarness("a rerun changes nothing; a rerun after the source changed publishes only what changed", async (h, src) => {
    const scan = await scanSource({ source: src });
    await runImport(scan, { deps: h.deps });
    const count = async () => (await h.deps.revisions.revisions({ tenant: "acme", workspace: "desk" })).length;
    const n = await count();
    const again = await runImport(await scanSource({ source: src }), { deps: h.deps });
    assert.deepEqual(again.results.map((r) => r.status), ["unchanged", "unchanged", "unchanged", "empty"]);
    assert.equal(await count(), n, "no new revision");

    fs.writeFileSync(path.join(src, "acme", "workspaces", "desk", "memory", "edited.md"), "new\n");
    const third = await runImport(await scanSource({ source: src }), { deps: h.deps });
    assert.equal(third.results[0].status, "imported");
    assert.equal(third.results[0].filesPublished, 1);
    assert.equal(third.results[0].filesStreamed, 0, "the large file was already there");
    assert.equal(await count(), n + 1);
  });

  withHarness("a workspace that fails halfway is retried alone, and the rest are not held up", async (h, src) => {
    let broken = true;
    const inner = h.deps.blobs;
    const flaky: Deps = {
      ...h.deps,
      blobs: {
        ...inner,
        kind: inner.kind,
        head: (k, o) => inner.head(k, o),
        get: (k, o) => inner.get(k, o),
        putIfAbsent: async (k, b, o) => {
          if (broken && k.startsWith("t/acme/") && b.length === BINARY.length) throw new Error("disk full");
          return inner.putIfAbsent(k, b, o);
        },
        putSourceIfAbsent: (k, s, o) => inner.putSourceIfAbsent(k, s, o),
      },
    };
    const scan = await scanSource({ source: src });
    const first = await runImport(scan, { deps: flaky });
    const by = Object.fromEntries(first.results.map((r) => [`${r.tenant}/${r.workspace}`, r]));
    assert.equal(by["acme/desk"].status, "failed");
    assert.match(by["acme/desk"].reason ?? "", /disk full/);
    assert.equal(by["beta/old"].status, "imported", "the other accounts went through");
    assert.equal(await h.deps.revisions.head({ tenant: "acme", workspace: "desk" }), null, "no head: never a half-published workspace");
    const failed = await verifyImport(scan, { deps: h.deps });
    assert.equal(failed.pass, false);
    assert.equal(failed.workspaces.find((w) => w.workspace === "desk")!.pass, false);
    assert.equal(failed.workspaces.find((w) => w.workspace === "old")!.pass, true);

    broken = false;
    const second = await runImport(scan, { deps: h.deps });
    assert.deepEqual(second.results.map((r) => r.status), ["imported", "unchanged", "unchanged", "empty"]);
    assert.equal((await verifyImport(scan, { deps: h.deps })).pass, true);
  });

  withHarness("verify notices a changed source file, a lost blob and extra work in the head", async (h, src) => {
    const scan = await scanSource({ source: src });
    await runImport(scan, { deps: h.deps });
    const desk = scan.tenants[0].workspaces[0];

    // the source changes after the import
    const agent = path.join(desk.dir, "agents", "writer", "AGENTS.md");
    fs.appendFileSync(agent, "changed\n");
    let v = await verifyImport(scan, { deps: h.deps });
    assert.equal(v.pass, false);
    assert.deepEqual(v.workspaces[0].mismatched, ["agents/writer/AGENTS.md"]);
    fs.writeFileSync(agent, fs.readFileSync(agent, "utf8").replace("changed\n", ""));
    assert.equal((await verifyImport(scan, { deps: h.deps })).pass, true);

    // a blob goes missing from the store
    const sweep = h.deps.blobs.delete;
    if (sweep) {
      const sha = desk.files.find((f) => f.path === "flows/publish.md")!.sha;
      const other = scan.tenants.flatMap((t) => t.workspaces).filter((w) => w.tenant === "acme" && w.workspace !== "desk" && w.files.some((f) => f.sha === sha));
      if (!other.length) {
        await sweep.call(h.deps.blobs, blobObjectKey("acme", sha));
        v = await verifyImport(scan, { deps: h.deps });
        assert.deepEqual(v.workspaces[0].badBlobs, ["flows/publish.md"]);
        assert.equal(v.pass, false);
        await h.deps.blobs.putIfAbsent(blobObjectKey("acme", sha), fs.readFileSync(desk.files.find((f) => f.path === "flows/publish.md")!.abs));
      }
    }

    // someone works in the workspace after the import
    const sha = sha256Hex("hello\n");
    await publish(h.deps, {
      ws: { tenant: "acme", workspace: "desk" }, opId: "user-edit-0001", by: "user:ana", message: "a real edit",
      changes: { "memory/after.md": { op: "put", base: null, sha, size: 6, mode: 0o644 } }, bytesOf: async () => Buffer.from("hello\n"),
    });
    v = await verifyImport(scan, { deps: h.deps });
    assert.deepEqual(v.workspaces[0].extra, ["memory/after.md"]);
    assert.equal(v.workspaces[0].pass, false);
    assert.equal((await verifyImport(scan, { deps: h.deps, allowExtra: true })).workspaces[0].pass, true);
    const plan = await planImport(scan, h.deps);
    assert.match(plan[0].note ?? "", /user:ana.*--force/, "the dry run warns before an import would skip it");

    // a rerun must not undo it
    const skipped = await runImport(scan, { deps: h.deps });
    assert.equal(skipped.results[0].status, "skipped");
    assert.match(skipped.results[0].reason ?? "", /user:ana/);
    const m = await manifestsAt(h.deps, "acme", await headsOf(h.deps, { tenant: "acme", workspace: "desk" }));
    assert.ok(m.authored.files["memory/after.md"], "the later work is still there");
    const forced = await runImport(scan, { deps: h.deps, force: true });
    assert.notEqual(forced.results[0].status, "skipped");
    const m2 = await manifestsAt(h.deps, "acme", await headsOf(h.deps, { tenant: "acme", workspace: "desk" }));
    assert.ok(m2.authored.files["memory/after.md"], "even forced, an import never deletes without mirror");
    const mirrored = await runImport(scan, { deps: h.deps, force: true, mirror: true });
    assert.notEqual(mirrored.results[0].status, "skipped");
    assert.equal((await verifyImport(scan, { deps: h.deps })).workspaces[0].pass, true);
  });
}
