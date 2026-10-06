// Export a workspace, flow or agent as a .zip, and import one.
//
//   node --test tests/package.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { saveWorkspace, workspaceDir, blankTemplateFiles, readWorkspaceFile, listWorkspaces } from "../src/store.ts";
import { zip, unzip, crc32, ZipError } from "../src/zip.ts";
import {
  packageOf,
  packageZip,
  packageFilename,
  readPackage,
  planImport,
  applyImport,
  PackageError,
  MANIFEST_FILE,
} from "../src/package.ts";

function withData(body: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-package-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const agent = (name: string, extra = "") => `---\nname: ${name}\ndescription: ${name}.\n${extra}---\n\nDo the ${name} job.\n`;

function desk() {
  saveWorkspace("acme", "blog", [
    { path: "AGENTS.md", content: "---\nname: blog\n---\n\nThe blog desk.\n" },
    { path: "flows/publish.md", content: "---\ntrigger: manual\n---\n\n1. [[writer]] — Draft it.\n2. [[editor]] — Tighten it.\n   on-fail: [[rescuer]]\n3. [[flow:announce]] — Tell people.\n" },
    { path: "flows/announce.md", content: "---\ntrigger: manual\n---\n\n1. [[herald]] — Announce.\n" },
    { path: "flows/other.md", content: "---\ntrigger: manual\n---\n\n1. [[loner]] — Alone.\n" },
    { path: "agents/writer/agent.md", content: agent("writer", "tools: [read, cms]\nskills: [house-style]\nscripts: [count.py]\nsubagents: [researcher]\nsecrets: [CMS_TOKEN]\n") },
    { path: "agents/writer/memory/lesson.md", content: "---\ntype: Fact\n---\n\nLearned here.\n" },
    { path: "agents/researcher/agent.md", content: agent("researcher") },
    { path: "agents/editor/agent.md", content: agent("editor") },
    { path: "agents/rescuer/agent.md", content: agent("rescuer") },
    { path: "agents/herald/agent.md", content: agent("herald", "tools: [poster]\n") },
    { path: "agents/loner/agent.md", content: agent("loner") },
    { path: "tools/cms.md", content: "---\nname: cms\nbase: https://cms.example\nheaders:\n  Authorization: Bearer ${CMS_KEY}\n---\n\nThe CMS.\n" },
    { path: "tools/poster/tool.md", content: "---\nname: poster\nrun: run.mjs\nsecrets: [POSTER_TOKEN]\n---\n\nPosts.\n" },
    { path: "tools/poster/run.mjs", content: "console.log('posted')\n" },
    { path: "tools/unused.md", content: "---\nname: unused\nbase: https://x.example\n---\n" },
    { path: "skills/house-style/SKILL.md", content: "---\nname: house-style\ndescription: How we write.\n---\n\nShort.\n" },
    { path: "scripts/count.py", content: "print(1)\n" },
    { path: "knowledge/voice.md", content: "---\ntype: Concept\n---\n\nPlain.\n" },
    { path: "memory/desk.md", content: "---\ntype: Fact\n---\n\nRun-made.\n" },
    { path: "state/cursor.json", content: "{\"at\": 3}\n" },
  ]);
}

test("zip round-trips, and the reader refuses what it must", () => {
  const files = [
    { path: "a.md", data: Buffer.from("hello ".repeat(200)) },
    { path: "dir/b.txt", data: Buffer.from("x") },
    { path: "dir/ünï.md", data: Buffer.from("text") },
  ];
  const back = unzip(zip(files));
  assert.deepEqual(back.map((e) => [e.path, e.data.toString()]), files.map((e) => [e.path, e.data.toString()]));
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);

  assert.throws(() => unzip(Buffer.from("not a zip at all, just text bytes here")), ZipError);
  assert.throws(() => zip([{ path: "../escape.md", data: Buffer.from("x") }]), /unsafe path/);
  assert.throws(() => zip([{ path: "/abs.md", data: Buffer.from("x") }]), /unsafe path/);
  // A bomb: small on the wire, large inflated — refused by the header and by the inflate cap.
  const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
  assert.throws(() => unzip(zip([{ path: "big.md", data: big }]), { maxFileBytes: 1024 * 1024 }), /too large/);
  // A header that lies about the size is caught by the inflate cap, not trusted.
  const lying = zip([{ path: "big.md", data: big }]);
  const cd = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lying.writeUInt32LE(10, cd + 24);
  assert.throws(() => unzip(lying, { maxFileBytes: 1024 }), ZipError);
  assert.ok(zlib.deflateRawSync(big).length < 10_000, "the bomb really is small on the wire");
});

test("a workspace exports its authored tree — never memory, state or the engine's files", () => {
  withData(() => {
    desk();
    fs.mkdirSync(path.join(workspaceDir("acme", "blog"), "agents/writer/.claude"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir("acme", "blog"), "agents/writer/.claude/settings.json"), "{}");
    const pkg = packageOf("acme", "blog", "workspace");
    const paths = pkg.files.map((f) => f.path);
    assert.ok(paths.includes("AGENTS.md") && paths.includes("tools/poster/run.mjs") && paths.includes("knowledge/voice.md"));
    for (const p of paths) assert.doesNotMatch(p, /(^|\/)(memory|state)\/|\.claude/, p);
    assert.equal(pkg.manifest.kind, "workspace");
    assert.equal(packageFilename(pkg.manifest), "blog.zip");
  });
});

test("a flow exports itself, its subflows, every agent they need and the tools those agents grant", () => {
  withData(() => {
    desk();
    const pkg = packageOf("acme", "blog", "flow", "publish");
    assert.deepEqual(pkg.files.map((f) => f.path), [
      "agents/editor/agent.md",
      "agents/herald/agent.md",
      "agents/rescuer/agent.md",
      "agents/researcher/agent.md",
      "agents/writer/agent.md",
      "flows/announce.md",
      "flows/publish.md",
      "scripts/count.py",
      "skills/house-style/SKILL.md",
      "tools/cms.md",
      "tools/poster/run.mjs",
      "tools/poster/tool.md",
    ]);
    assert.equal(packageFilename(pkg.manifest), "blog-flow-publish.zip");
    assert.throws(() => packageOf("acme", "blog", "flow", "nosuch"), (e: unknown) => e instanceof PackageError && e.status === 404);
  });
});

test("an agent exports its folder and what it grants, not its colleagues", () => {
  withData(() => {
    desk();
    const pkg = packageOf("acme", "blog", "agent", "writer");
    assert.deepEqual(pkg.files.map((f) => f.path), ["agents/writer/agent.md", "scripts/count.py", "skills/house-style/SKILL.md", "tools/cms.md"]);
    assert.throws(() => packageOf("acme", "blog", "agent", "nosuch"), (e: unknown) => e instanceof PackageError && e.status === 404);
  });
});

test("importing a flow into another workspace: preview, needs, one revision", () => {
  withData(() => {
    desk();
    saveWorkspace("acme", "fresh", blankTemplateFiles("fresh"));
    const pkg = readPackage(packageZip(packageOf("acme", "blog", "flow", "publish")));
    assert.equal(pkg.manifest.kind, "flow");
    assert.equal(pkg.manifest.workspace, "blog");

    const plan = planImport("acme", "fresh", pkg);
    assert.equal(plan.creates, false);
    assert.equal(plan.added.length, 12);
    assert.deepEqual(plan.overwritten, []);
    // Secrets the files name and the account does not have — from the agent,
    // a tool's secrets: and a ${PLACEHOLDER}.
    assert.deepEqual(plan.needs.secrets, ["CMS_KEY", "CMS_TOKEN", "POSTER_TOKEN"]);
    assert.deepEqual(plan.needs.agents, []);
    assert.deepEqual(plan.needs.tools, []);

    const r = applyImport("acme", "fresh", pkg, { by: "test" });
    assert.equal(r.written.length, 12);
    assert.ok(r.revision, "the import is one revision");
    assert.equal(readWorkspaceFile("acme", "fresh", "flows/publish.md"), readWorkspaceFile("acme", "blog", "flows/publish.md"));
    assert.ok(fs.statSync(path.join(workspaceDir("acme", "fresh"), "tools/poster/run.mjs")).mode & 0o100, "tool code stays executable");

    // Again: nothing to do.
    const again = planImport("acme", "fresh", pkg);
    assert.equal(again.unchanged.length, 12);
    assert.equal(applyImport("acme", "fresh", pkg).written.length, 0);
  });
});

test("an import never overwrites without being told, and never deletes", () => {
  withData(() => {
    desk();
    saveWorkspace("acme", "fresh", [...blankTemplateFiles("fresh"), { path: "agents/editor/agent.md", content: agent("editor", "model: max\n") }, { path: "agents/keep/agent.md", content: agent("keep") }]);
    const pkg = readPackage(packageZip(packageOf("acme", "blog", "flow", "publish")));
    const plan = planImport("acme", "fresh", pkg);
    assert.deepEqual(plan.overwritten, ["agents/editor/agent.md"]);
    assert.throws(() => applyImport("acme", "fresh", pkg), (e: unknown) => e instanceof PackageError && e.status === 409 && /editor/.test(e.message));
    assert.match(readWorkspaceFile("acme", "fresh", "agents/editor/agent.md"), /model: max/, "a refused import wrote nothing");
    applyImport("acme", "fresh", pkg, { overwrite: true });
    assert.doesNotMatch(readWorkspaceFile("acme", "fresh", "agents/editor/agent.md"), /model: max/);
    assert.ok(fs.existsSync(path.join(workspaceDir("acme", "fresh"), "agents/keep/agent.md")), "a file the package lacks stays");
  });
});

test("a workspace package makes a new workspace; an agent package names what it lacks", () => {
  withData(() => {
    desk();
    const ws = readPackage(packageZip(packageOf("acme", "blog", "workspace")));
    const plan = planImport("other", "blog-copy", ws);
    assert.equal(plan.creates, true);
    applyImport("other", "blog-copy", ws, { by: "test" });
    assert.ok(listWorkspaces("other").some((w) => w.name === "blog-copy"));
    assert.equal(readWorkspaceFile("other", "blog-copy", "flows/publish.md"), readWorkspaceFile("acme", "blog", "flows/publish.md"));
    assert.equal(fs.existsSync(path.join(workspaceDir("other", "blog-copy"), "memory/desk.md")), false);

    const one = readPackage(packageZip(packageOf("acme", "blog", "agent", "writer")));
    saveWorkspace("other", "empty", blankTemplateFiles("empty"));
    assert.deepEqual(planImport("other", "empty", one).needs.agents, ["researcher"], "a subagent it delegates to is named, not carried");
    // A flow or agent goes into a workspace that exists.
    assert.throws(() => planImport("other", "nowhere", one), (e: unknown) => e instanceof PackageError && e.status === 404);
  });
});

test("readPackage refuses memory, state, escapes and non-text; accepts a hand-zipped folder", () => {
  const z = (files: Record<string, string>) => zip(Object.entries(files).map(([p, c]) => ({ path: p, data: Buffer.from(c) })));
  assert.throws(() => readPackage(z({ "AGENTS.md": "x", "memory/x.md": "y" })), /may not write/);
  assert.throws(() => readPackage(z({ "agents/a/agent.md": agent("a"), "agents/a/state/s.json": "{}" })), /may not write/);
  assert.throws(() => readPackage(z({ "secrets.json": "{}" })), /may not write/);
  assert.throws(() => readPackage(Buffer.from("garbage")), (e: unknown) => e instanceof PackageError && e.status === 400);
  assert.throws(
    () => readPackage(zip([{ path: "agents/a/agent.md", data: Buffer.from([0xff, 0xfe, 0x00]) }])),
    /not UTF-8/,
  );
  assert.throws(() => readPackage(z({ [MANIFEST_FILE]: JSON.stringify({ format: "foldrun-package", version: 9 }), "AGENTS.md": "x" })), /newer/);
  // A Mac's "Compress" of the folder: one top directory, plus __MACOSX noise.
  const hand = readPackage(z({ "blog/AGENTS.md": "---\nname: blog\n---\n", "blog/flows/f.md": "1. [[a]] — x\n", "__MACOSX/blog/._AGENTS.md": "junk" }));
  assert.equal(hand.manifest.kind, "workspace");
  assert.deepEqual(hand.files.map((f) => f.path), ["AGENTS.md", "flows/f.md"]);
});
