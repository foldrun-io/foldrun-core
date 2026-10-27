// A step's sandbox hands back data, never configuration or code (FOL-96).
//
// A step steered by what it read could rewrite AGENTS.md, an agent.md, a
// flow or a tool on the way back from its sandbox — its own tools: and
// network:, a provider: block, a new scheduled flow — and every later run,
// the next step of the same run included, ran on it. The list is read off
// the kinds registry, so a new kind is classified the moment it exists.
//
//   node --test tests/copy-back.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KINDS, ALL_KINDS } from "../src/kinds.ts";
import { refusedBack, refusedLine, type RefusedPath } from "../src/copy-back.ts";
import { applyContainerChanges, handedInPath, writeHandedIn, readHandedIn, dropHandedIn, type RunInContainerArgs, type ContainerStepOutcome } from "../src/run-container.ts";
import { checkPaths } from "../src/confine.ts";
import { isPlatformPath } from "../src/store.ts";
import { startFlowRun, waitForRun } from "../src/runner.ts";
import { registerPlatform, platform } from "../src/platform.ts";

const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

/** Three trees — host, what was handed in, what came out — from one spec. */
function trees(spec: { host?: Record<string, string>; handed?: Record<string, string>; out?: Record<string, string> }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-copyback-"));
  const dirs = { host: path.join(base, "host"), handed: path.join(base, "in"), out: path.join(base, "out") };
  for (const [k, files] of Object.entries(spec) as [keyof typeof dirs, Record<string, string>][]) {
    for (const [rel, text] of Object.entries(files ?? {})) {
      const abs = path.join(dirs[k], rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
  }
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return { ...dirs, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const read = (dir: string, rel: string) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), "utf8") : null);

test("every kind is classified, and refusedBack says the same of its files — a new kind cannot slip through", () => {
  for (const kind of ALL_KINDS) {
    const cls = KINDS[kind].copyBack;
    assert.ok(cls === "config" || cls === "code" || cls === "data", `${kind}: copyBack must be config, code or data, not ${String(cls)}`);
    const want = cls === "data" ? null : cls;
    assert.equal(refusedBack(KINDS[kind].file("x")), want, `${kind}: ${KINDS[kind].file("x")}`);
    if (KINDS[kind].scopes.includes("agent") && kind !== "agents") {
      assert.equal(refusedBack(`agents/w/${KINDS[kind].file("x")}`), want, `${kind} at agent scope`);
    }
  }
});

test("configuration and code are refused, wherever the registry says they live", () => {
  const cases: [string, "config" | "code"][] = [
    ["AGENTS.md", "config"],
    ["project.md", "config"],
    ["agents/w/agent.md", "config"],
    ["flows/x.md", "config"],
    ["flows/sub/y.md", "config"],
    ["tools/x.md", "config"],
    ["tools/x.sh", "config"],
    ["tools/x/run.mjs", "config"],
    ["skills/s/SKILL.md", "config"],
    ["agents/w/skills/s/run.py", "config"],
    ["evals/e.md", "config"],
    ["hooks/h/run.mjs", "code"],
    ["scripts/run.py", "code"],
    ["agents/w/scripts/run.py", "code"],
    [".claude/agents/x.md", "config"],
    [".agents/agents/x.md", "config"],
    [".agents/skills/x/SKILL.md", "config"],
  ];
  for (const [rel, kind] of cases) assert.equal(refusedBack(rel), kind, rel);
});

test("lookalike paths are data and still come back", () => {
  for (const rel of [
    "agents/w/notes.md",
    "agents/w/outputs/flows.md",
    "agents/w/outputs/AGENTS.md",
    "agents/w/agent.md.bak",
    "agents/w/memory/fact.md",
    "state/flows/x.md",
    "state/AGENTS.md",
    "memory/AGENTS.md.bak",
    "storage/tools/x.sh",
    "storage/scripts/run.py",
    "outputs/skills/s/SKILL.md",
    "flows.md",
    "toolsmith/x.md",
  ]) {
    assert.equal(refusedBack(rel), null, rel);
  }
});

test("a step that edits AGENTS.md, agent.md, a flow and a tool: nothing comes back, every path is named; state/ and memory/ do", () => {
  const t = trees({
    host: { "AGENTS.md": "A0", "agents/w/agent.md": "W0", "flows/x.md": "F0", "flows/keep.md": "K0", "tools/x.sh": "T0", "state/cursor.json": "1" },
    handed: { "AGENTS.md": "A0", "agents/w/agent.md": "W0", "flows/x.md": "F0", "flows/keep.md": "K0", "tools/x.sh": "T0", "state/cursor.json": "1" },
    out: {
      "AGENTS.md": "A1 — network: open",
      "agents/w/agent.md": "W1 — tools: [bash]",
      "flows/x.md": "F1",
      "flows/keep.md": "K0",
      "flows/new.md": "a new scheduled flow",
      "tools/x.sh": "T1",
      "scripts/run.py": "print('later')",
      "state/cursor.json": "2",
      "memory/note.md": "learned",
    },
  });
  try {
    const refused: RefusedPath[] = [];
    const applied = applyContainerChanges(t.host, t.out, t.handed, undefined, undefined, { onRefused: (r) => refused.push(r) });
    assert.equal(read(t.host, "AGENTS.md"), "A0");
    assert.equal(read(t.host, "agents/w/agent.md"), "W0");
    assert.equal(read(t.host, "flows/x.md"), "F0");
    assert.equal(read(t.host, "tools/x.sh"), "T0");
    assert.equal(read(t.host, "flows/new.md"), null, "a new flow never lands");
    assert.equal(read(t.host, "scripts/run.py"), null, "nor new code");
    assert.equal(read(t.host, "state/cursor.json"), "2");
    assert.equal(read(t.host, "memory/note.md"), "learned");
    assert.deepEqual(applied.sort(), ["memory/note.md", "state/cursor.json"]);
    assert.deepEqual(
      refused.map((r) => `${r.path}:${r.kind}`).sort(),
      ["AGENTS.md:config", "agents/w/agent.md:config", "flows/new.md:config", "flows/x.md:config", "scripts/run.py:code", "tools/x.sh:config"],
      "only what the step changed — flows/keep.md came back as it went in",
    );
    assert.match(refusedLine(refused), /^refused path: .*AGENTS\.md \(config\).*Proposed fixes/);
  } finally {
    t.done();
  }
});

test("without a baseline (a driver that lost its record) a config file the step left alone is not reported", () => {
  const t = trees({ host: { "AGENTS.md": "A0", "flows/x.md": "F0" }, out: { "AGENTS.md": "A0", "flows/x.md": "F1" } });
  try {
    const refused: RefusedPath[] = [];
    applyContainerChanges(t.host, t.out, undefined, undefined, undefined, { onRefused: (r) => refused.push(r) });
    assert.deepEqual(refused, [{ path: "flows/x.md", kind: "config" }]);
    assert.equal(read(t.host, "flows/x.md"), "F0");
  } finally {
    t.done();
  }
});

test("a refused path makes no conflict copy, even when the workspace moved too (F5)", () => {
  const t = trees({
    host: { "flows/x.md": "F-person" },
    handed: { "flows/x.md": "F0" },
    out: { "flows/x.md": "F-step" },
  });
  try {
    const refused: RefusedPath[] = [];
    const notes: string[] = [];
    const applied = applyContainerChanges(t.host, t.out, t.handed, (m) => notes.push(m), undefined, { onRefused: (r) => refused.push(r) });
    assert.deepEqual(applied, []);
    assert.deepEqual(fs.readdirSync(path.join(t.host, "flows")), ["x.md"], "no flows/x.conflict-*.md — that would be a new live flow");
    assert.equal(read(t.host, "flows/x.md"), "F-person");
    assert.deepEqual(notes, []);
    assert.deepEqual(refused, [{ path: "flows/x.md", kind: "config" }]);
  } finally {
    t.done();
  }
});

test("a test run refuses the same paths; its state/ still goes aside (F4)", () => {
  const t = trees({
    host: { "AGENTS.md": "A0", "state/s.md": "s0" },
    handed: { "AGENTS.md": "A0", "state/s.md": "s0" },
    out: { "AGENTS.md": "A1", "state/s.md": "s1" },
  });
  const aside = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-divert-"));
  try {
    const refused: RefusedPath[] = [];
    const diverted: string[] = [];
    applyContainerChanges(t.host, t.out, t.handed, undefined, { to: aside, note: (rel) => diverted.push(rel) }, { onRefused: (r) => refused.push(r) });
    assert.equal(read(t.host, "AGENTS.md"), "A0");
    assert.equal(read(aside, "AGENTS.md"), null, "not diverted either — refused");
    assert.deepEqual(refused, [{ path: "AGENTS.md", kind: "config" }]);
    assert.deepEqual(diverted, ["state/s.md"]);
    assert.equal(read(t.host, "state/s.md"), "s0");
    assert.equal(read(aside, "state/s.md"), "s1");
  } finally {
    t.done();
    fs.rmSync(aside, { recursive: true, force: true });
  }
});

test("the sandbox's note of what was copied back counts only where the host handed those bytes (F6)", () => {
  // Handed in A; the job's B is on the host; the sandbox appended C. A forged
  // note claiming the file was already "B\nC\n" must not make C vanish or
  // make the merge skip the host's B.
  const t = trees({
    host: { "state/log.md": "A\nB\n" },
    handed: { "state/log.md": "A\n" },
    out: { "state/log.md": "A\nB\nC\n", ".foldrun/copied-back.json": JSON.stringify({ "state/log.md": sha("A\nB\nC\n") }) },
  });
  try {
    // Nothing handed back by the host: the forged entry is ignored and the
    // file reads as the step's own change against what it was handed — both
    // sides' additions kept (noisy, never lost), not what the note claimed.
    applyContainerChanges(t.host, t.out, t.handed, undefined, undefined, { handedBack: {} });
    assert.equal(read(t.host, "state/log.md"), "A\nB\nB\nC\n", "merged against the real baseline, not the forged one");
  } finally {
    t.done();
  }
  const t2 = trees({
    host: { "state/log.md": "A\nB\n" },
    handed: { "state/log.md": "A\n" },
    out: { "state/log.md": "A\nB\nC\n", ".foldrun/copied-back.json": JSON.stringify({ "state/log.md": sha("A\nB\n") }) },
  });
  try {
    // The host handed exactly "A\nB\n" back: the note agrees, so B is not
    // applied twice.
    applyContainerChanges(t2.host, t2.out, t2.handed, undefined, undefined, { handedBack: { "state/log.md": sha("A\nB\n") } });
    assert.equal(read(t2.host, "state/log.md"), "A\nB\nC\n");
  } finally {
    t2.done();
  }
});

test("what a sandbox was handed is kept on the host, under the run, outside anything a sandbox sees (F6)", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-handed-"));
  try {
    const file = handedInPath(ws, "run-abc", "foldrun-run-x1")!;
    assert.ok(isPlatformPath(path.relative(ws, file)), "runs/ is never staged in nor copied back");
    assert.equal(handedInPath(ws, "../x", "p"), null);
    assert.equal(handedInPath(ws, "run", "../../AGENTS"), null);
    writeHandedIn(ws, "run-abc", "foldrun-run-x1", { "a.md": "h" });
    assert.deepEqual(readHandedIn(ws, "run-abc", "foldrun-run-x1"), { "a.md": "h" });
    dropHandedIn(ws, "run-abc", "foldrun-run-x1");
    assert.equal(readHandedIn(ws, "run-abc", "foldrun-run-x1"), undefined);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("a laptop step's file tools are refused on configuration and code; data stays writable (F7)", () => {
  const WS = "/data/acme/workspaces/desk";
  const roots = { agentDir: `${WS}/agents/writer`, workspaceRoot: WS, libraryRoot: "/data/acme/library" };
  for (const p of [`${WS}/AGENTS.md`, `${WS}/agents/writer/agent.md`, `${WS}/flows/x.md`, `${WS}/tools/x.sh`, `${WS}/scripts/r.py`, "workspace/flows/y.md"]) {
    for (const tool of ["Write", "Edit"]) {
      const v = checkPaths(tool, { file_path: p }, roots);
      assert.equal(v.ok, false, `${tool} ${p}`);
      assert.match(v.reason ?? "", /configuration|code/);
    }
    assert.equal(checkPaths("Read", { file_path: p }, roots).ok, true, `reading ${p} is fine`);
  }
  for (const p of [`${WS}/agents/writer/outputs/flows.md`, `${WS}/state/x.md`, "workspace/memory/fact.md", `${WS}/agents/writer/notes.md`]) {
    assert.equal(checkPaths("Write", { file_path: p }, roots).ok, true, p);
  }
});

test("step 2 of the same run is staged from the workspace's own AGENTS.md, and step 1's refusals are on its record (F3)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-f3-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  const prevIso = platform.isolation;
  // A sandbox as the real runners make one: a copy of the workspace in, the
  // step's changes out through applyContainerChanges.
  const fake = async (args: RunInContainerArgs): Promise<ContainerStepOutcome> => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-f3-box-"));
    const handed = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-f3-in-"));
    try {
      for (const dir of [box, handed]) {
        fs.cpSync(args.workspaceRoot, dir, { recursive: true, filter: (src) => !isPlatformPath(path.relative(args.workspaceRoot, src)) });
      }
      const agent = path.basename(args.input.agentRel);
      if (agent === "first") {
        fs.writeFileSync(path.join(box, "AGENTS.md"), "---\nname: desk\nnetwork: open\n---\nrewritten by step 1\n");
        fs.writeFileSync(path.join(box, "agents/second/agent.md"), "---\nname: second\ndescription: x\ntools: [bash]\n---\n");
        fs.mkdirSync(path.join(box, "state"), { recursive: true });
        fs.writeFileSync(path.join(box, "state/from-first.md"), "kept");
      }
      const seen = fs.readFileSync(path.join(box, "AGENTS.md"), "utf8");
      const refused: RefusedPath[] = [];
      const applied = applyContainerChanges(args.workspaceRoot, box, handed, undefined, args.divert, { onRefused: (r) => refused.push(r) });
      return { status: "completed", result: agent === "second" ? `saw: ${seen}` : "done", costUsd: 0, applied, ...(refused.length ? { refused } : {}) };
    } finally {
      fs.rmSync(box, { recursive: true, force: true });
      fs.rmSync(handed, { recursive: true, force: true });
    }
  };
  registerPlatform({ isolation: { fake } });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    for (const a of ["first", "second"]) {
      fs.mkdirSync(path.join(ws, "agents", a), { recursive: true });
      fs.writeFileSync(path.join(ws, "agents", a, "agent.md"), `---\nname: ${a}\ndescription: works\n---\n\nWork.\n`);
    }
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    const original = "---\nname: desk\n---\nthe person's\n";
    fs.writeFileSync(path.join(ws, "AGENTS.md"), original);
    const run = startFlowRun("acme", "desk", [
      { agent: "first", instruction: "go", group: 1, optional: false },
      { agent: "second", instruction: "go", group: 2, optional: false },
    ], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed");
    assert.equal(done!.steps[1].result, `saw: ${original}`, "step 2 ran on the workspace's AGENTS.md, not step 1's");
    assert.equal(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8"), original);
    assert.match(fs.readFileSync(path.join(ws, "agents/second/agent.md"), "utf8"), /description: works/);
    assert.equal(fs.readFileSync(path.join(ws, "state/from-first.md"), "utf8"), "kept");
    assert.deepEqual(done!.steps[0].refused, [
      { path: "AGENTS.md", kind: "config" },
      { path: "agents/second/agent.md", kind: "config" },
    ]);
    assert.equal(done!.steps[1].refused, undefined);
  } finally {
    registerPlatform({ isolation: prevIso });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
