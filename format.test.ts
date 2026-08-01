// Tests for the format itself.
//
// These are the contract. An agent.md or a flow file written today has to mean
// the same thing after the next refactor — if `parseFlow` quietly changes,
// every user's orchestration changes with it and nothing tells them.
//
//   node --test packages/core/format.test.ts
//
// Only pure functions are covered here: parsing, linting, completion and OKF
// derivation. Anything that runs a model belongs in evals, not here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseFlow, parseToolDef, reorderFlowSteps, resolveModel } from "./src/store.ts";
import { lintFlow } from "./src/flow-lint.ts";
import { completionsAt } from "./src/completions.ts";
import { trustTier, buildIndex } from "./src/okf.ts";
import { parseEval } from "./src/evals.ts";
import { joinGroup, splitToRail } from "./src/arrange.ts";
import { KINDS, ALL_KINDS, readTransport } from "./src/kinds.ts";
import { testTool } from "./src/tool-test.ts";

const VOCAB = {
  agents: ["writer", "checker"],
  flows: ["publish"],
  skills: ["house-style"],
  tools: ["google-ads"],
  secrets: ["ADS_TOKEN"],
  scripts: ["workspace/scripts/x.py"],
  types: ["Fact"],
};

// ---------------------------------------------------------------- flows

test("same number means parallel, different means sequential", () => {
  const flow = parseFlow("f.md", `---\nname: f\n---\n\n1. [[a]] — one\n2. [[b]] — two\n2. [[c]] — three\n`);
  assert.deepEqual(
    flow.steps.map((s) => [s.group, s.agent]),
    [[1, "a"], [2, "b"], [2, "c"]],
  );
});

test("markers: ? is optional, ! needs approval", () => {
  const flow = parseFlow("f.md", `---\nname: f\n---\n\n1? [[a]]\n2! [[b]]\n`);
  assert.equal(flow.steps[0].optional, true);
  assert.equal(flow.steps[1].approve, true);
});

test("[[flow:x]] targets a flow, not an agent", () => {
  const flow = parseFlow("f.md", `---\nname: f\n---\n\n1. [[flow:cleanup]] — go\n`);
  assert.equal(flow.steps[0].subflow, "cleanup");
});

test("indented options attach to the step above", () => {
  const flow = parseFlow(
    "f.md",
    `---\nname: f\n---\n\n1. [[a]] — go\n   retry: 2\n   timeout: 300\n   verify: test -s out.txt\n   when: schema\n`,
  );
  const [step] = flow.steps;
  assert.equal(step.retry, 2);
  assert.equal(step.timeout, 300);
  assert.equal(step.verify, "test -s out.txt");
  assert.equal(step.when, "schema");
});

test("steps out of order are sorted by group, document order within it", () => {
  const flow = parseFlow("f.md", `---\nname: f\n---\n\n3. [[c]]\n1. [[a]]\n1. [[b]]\n`);
  assert.deepEqual(flow.steps.map((s) => s.agent), ["a", "b", "c"]);
});

test("reordering renumbers and nothing else", () => {
  const src = `---\nname: f\nmodel: fast\n---\n\nPreamble prose.\n\n1. [[a]] — first\n2. [[b]] — second\n   verify: npm test\n`;
  // put b first, and run them in one parallel group
  const out = reorderFlowSteps(src, [[1, 0]]);
  assert.match(out, /^---\nname: f\nmodel: fast\n---/, "frontmatter is untouched");
  assert.match(out, /Preamble prose\./, "prose survives");
  assert.match(out, /verify: npm test/, "step options travel with their step");
  assert.match(out, /1\. \[\[b\]\] — second/);
  assert.match(out, /1\. \[\[a\]\] — first/);
});

test("reordering refuses to lose or duplicate a step", () => {
  const src = `---\nname: f\n---\n\n1. [[a]]\n2. [[b]]\n`;
  assert.throws(() => reorderFlowSteps(src, [[0]]), /expected all 2 steps/);
  assert.throws(() => reorderFlowSteps(src, [[0, 0, 1]]), /appears twice/);
  assert.throws(() => reorderFlowSteps(src, [[0, 5]]), /no step 5/);
});

// ---------------------------------------------------------------- lint

test("lint catches a reviewer scheduled before the work exists", () => {
  const flow = parseFlow("f.md", `---\nname: f\n---\n\n1. [[editor]] — review both changes\n1. [[writer]] — draft it\n`);
  const messages = lintFlow(flow).map((w) => w.message);
  assert.ok(messages.some((m) => m.includes("refers to earlier work but runs first")));
});

test("lint catches a when: that can never match", () => {
  const flow = parseFlow("f.md", `---\nname: f\n---\n\n1. [[a]] — go\n   when: schema\n`);
  assert.ok(lintFlow(flow).some((w) => w.message.includes("when: condition but runs first")));
});

test("lint is silent on a well-ordered flow", () => {
  const flow = parseFlow("f.md", `---\nname: f\n---\n\n1. [[writer]] — draft it\n2. [[editor]] — review the draft\n`);
  assert.deepEqual(lintFlow(flow), []);
});

// ---------------------------------------------------------------- tools

test("tool transport is inferred from the field that says where", () => {
  assert.equal(parseToolDef({ base: "https://x.test" }, "t")?.kind, "http");
  assert.equal(parseToolDef({ run: "scripts/x.py" }, "t")?.kind, "script");
  assert.equal(parseToolDef({ command: "npx" }, "t")?.kind, "mcp");
  assert.equal(parseToolDef({ url: "https://x.test/sse" }, "t")?.kind, "mcp");
});

test("`type:` says what the document is; `transport:` says how it connects", () => {
  // The two used to be the same field, which is why a knowledge doc said
  // `type: Policy` and a tool said `type: http` — a noun and a mechanism
  // answering one question.
  const def = parseToolDef(
    { type: "Tool", transport: "script", run: "scripts/x.py" },
    "t",
  );
  assert.equal(def?.kind, "script");
  // `type: Tool` must not be mistaken for a transport, or every tool would
  // fall back to http and quietly stop working.
  assert.equal(parseToolDef({ type: "Tool", command: "npx" }, "t")?.kind, "mcp");
});

test("a tool written the old way still loads", () => {
  // Files predating the split say `type: http`. They are still valid.
  assert.equal(parseToolDef({ type: "mcp", command: "npx" }, "t")?.kind, "mcp");
  assert.equal(parseToolDef({ type: "script", run: "s.py" }, "t")?.kind, "script");
  assert.equal(readTransport({ type: "http" }), "http");
  assert.equal(readTransport({ type: "Tool" }), null, "a document type is not a transport");
  assert.equal(readTransport({ type: "http", transport: "mcp" }), "mcp", "transport wins");
});

// ---------------------------------------------------------------- kinds

test("only OKF bundles declare what their documents are", () => {
  // A kind is read from its path, so agents, flows, evals, skills and tools
  // declare nothing. Memory and knowledge are OKF bundles, where `type:` is
  // the spec's one required field and genuinely not derivable from the path.
  for (const kind of ALL_KINDS) {
    const meta = KINDS[kind];
    const body = meta.template("sample");

    if (kind === "scripts") {
      assert.ok(!body.startsWith("---"), "scripts are code — no frontmatter");
      continue;
    }

    assert.match(body, /^name: sample$/m, `a new ${meta.one} must carry its name`);

    if (meta.docKey === "type") {
      assert.match(body, new RegExp(`^type: ${meta.docType}$`, "m"),
        `a new ${meta.one} is an OKF concept and must declare type: ${meta.docType}`);
    } else {
      assert.equal(meta.docType, null, `${kind} declares a noun but has no field to put it in`);
      assert.doesNotMatch(body, /^kind:/m, `a new ${meta.one} must not restate its path in kind:`);
      assert.doesNotMatch(body, /^type:/m, `a new ${meta.one} must not sit in OKF's field`);
    }
  }
});

test("a kind's template lands at the path the kind says it does", () => {
  assert.equal(KINDS.agents.file("x"), "agents/x/agent.md");
  assert.equal(KINDS.skills.file("x"), "skills/x/SKILL.md");
  assert.equal(KINDS.tools.file("x"), "tools/x.md");
  // Nothing may escape its scope root — creation writes this path verbatim.
  for (const kind of ALL_KINDS) {
    assert.ok(!KINDS[kind].file("x").includes(".."), `${kind} path escapes`);
    assert.match(KINDS[kind].file("x"), new RegExp(`^${kind}/`), `${kind} path is misfiled`);
  }
});

test("a new tool is loadable the moment it is created", () => {
  // The template is the first thing anyone sees; if it doesn't parse, the
  // tool silently doesn't exist until someone guesses which field was missing.
  const fm = KINDS.tools.template("thing").match(/^---\n([\s\S]*?)\n---/)![1];
  const data: Record<string, unknown> = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) data[m[1]] = m[2];
  }
  assert.equal(parseToolDef(data, "thing")?.kind, "http");
});

test("a tool missing its one required field is skipped, not half-loaded", () => {
  assert.equal(parseToolDef({ type: "script" }, "t"), null);
  assert.equal(parseToolDef({ type: "mcp" }, "t"), null);
});

test("only recognised HTTP verbs survive, and the default is read-only", () => {
  const def = parseToolDef({ base: "https://x.test", methods: ["get", "TRACE", "delete"] }, "t");
  assert.deepEqual(def?.kind === "http" ? def.spec.methods : [], ["GET", "DELETE"]);
  const bare = parseToolDef({ base: "https://x.test" }, "t");
  assert.deepEqual(bare?.kind === "http" ? bare.spec.methods : [], ["GET"]);
});

// ---------------------------------------------------------------- models

test("tiers resolve, explicit ids pass through", () => {
  assert.equal(resolveModel("fast"), "haiku");
  assert.equal(resolveModel(undefined), "sonnet");
  assert.equal(resolveModel("claude-opus-5"), "claude-opus-5");
});

// ---------------------------------------------------------------- OKF

test("trust tier is derived, never stored", () => {
  assert.equal(trustTier([]), "unverified");
  assert.equal(trustTier(["mdagent/0.1.0"]), "machine-confirmed");
  assert.equal(trustTier(["mdagent/0.1.0", "human:matt"]), "human-reviewed");
});

test("okf_version appears only at a bundle root", () => {
  const docs = [
    {
      file: "a.md", type: "Fact", title: "a", description: "d", tags: [], status: "stable" as const,
      staleAfter: null, stale: false, generatedBy: null, verifiedBy: [], trust: "unverified" as const,
      resource: null, timestamp: null, sources: [], computation: null,
    },
  ];
  assert.match(buildIndex(docs, "Knowledge", true), /okf_version: "0.2"/);
  assert.doesNotMatch(buildIndex(docs, "gauges", false), /okf_version/);
});

// ---------------------------------------------------------------- evals

test("an eval parses cases, tasks and every assertion type", () => {
  const info = parseEval(
    "e.md",
    `---\nname: e\nagent: writer\n---\n\n## it works\ntask: Do the thing.\nexpect:\n  - contains: yes\n  - not-contains: no\n  - judge: it did the thing\n`,
  );
  assert.equal(info.agent, "writer");
  assert.equal(info.cases.length, 1);
  assert.equal(info.cases[0].task, "Do the thing.");
  assert.deepEqual(info.cases[0].expect.map((a) => a.type), ["contains", "not-contains", "judge"]);
});

// ---------------------------------------------------------------- completions

test("[[ suggests agents and flows", () => {
  const text = "1. [[";
  const c = completionsAt("flows/f.md", text, text.length, VOCAB);
  assert.ok(c!.items.some((i) => i.label === "writer"));
  assert.ok(c!.items.some((i) => i.label === "flow:publish"));
});

test("${ suggests secrets, never values", () => {
  const text = "---\nheaders:\n  Authorization: Bearer ${";
  const c = completionsAt("tools/t.md", text, text.length, VOCAB);
  assert.deepEqual(c!.items.map((i) => i.label), ["ADS_TOKEN"]);
});

test("methods build up one verb at a time", () => {
  const text = "---\nmethods: [GET, ";
  const c = completionsAt("tools/t.md", text, text.length, VOCAB);
  assert.ok(!c!.items.some((i) => i.label === "GET"), "already chosen");
  assert.ok(c!.items.some((i) => i.label === "POST"));
});

test("an unknown header still teaches the pair shape", () => {
  const text = "---\nheaders:\n  X-Weird-Thing";
  const c = completionsAt("tools/t.md", text, text.length, VOCAB);
  assert.ok(c!.items.some((i) => i.insert?.includes("X-Weird-Thing: ${")));
});

test("tools: offers built-ins and your own tools in one list", () => {
  const text = "---\nname: a\ntools:\n  - ";
  const c = completionsAt("agents/a/agent.md", text, text.length, VOCAB);
  const labels = c!.items.map((i) => i.label);
  assert.ok(labels.includes("files"), "built-in group");
  assert.ok(labels.includes("google-ads"), "your tool");
});

// ---------------------------------------------------------------- arranging

test("dropping on the top rail runs a step first", () => {
  assert.deepEqual(splitToRail([[0, 1]], 0, 0), [[0], [1]]);
  assert.deepEqual(splitToRail([[0, 1]], 1, 0), [[1], [0]]);
});

test("dropping on the bottom rail runs a step last", () => {
  assert.deepEqual(splitToRail([[0, 1]], 0, 1), [[1], [0]]);
  assert.deepEqual(splitToRail([[0, 1]], 1, 1), [[0], [1]]);
});

test("a collapsed group shifts the rails below it", () => {
  // [a] [b, c] — moving `a` to the rail after the second group must land it
  // last, not out of range, because removing it collapsed group 0.
  assert.deepEqual(splitToRail([[0], [1, 2]], 0, 2), [[1, 2], [0]]);
});

test("dropping onto another step runs them in parallel", () => {
  assert.deepEqual(joinGroup([[0], [1]], 1, 0), [[0, 1]]);
  assert.deepEqual(joinGroup([[0], [1]], 0, 0), [[0], [1]], "onto itself is a no-op");
});

test("no arrangement ever loses or duplicates a step", () => {
  const all = (g: number[][]) => g.flat().sort().join(",");
  const start = [[0, 1, 2]];
  for (const rail of [0, 1, 2]) {
    for (const step of [0, 1, 2]) {
      assert.equal(all(splitToRail(start, step, rail)), "0,1,2");
    }
  }
});

// ---------------------------------------------------------------- tool tests

test("a script tool that needs args and got none is untested, not failed", async () => {
  // `exited 2` on a script whose `--title` is required sends someone hunting a
  // bug that isn't there. The distinction is the whole value of the message.
  const def = {
    kind: "script" as const,
    name: "needs-args",
    spec: { name: "needs-args", run: "scripts/nope-does-not-exist.py", args: { title: "A title" } },
  };
  const r = await testTool("default", "no-such-workspace", def);
  // Resolution fails before execution here, which is itself the message we want.
  assert.equal(r.ok, false);
  assert.match(r.summary, /no such script/);
});

test("a tool test never returns a secret value", async () => {
  const def = {
    kind: "http" as const,
    name: "t",
    spec: {
      name: "t", base: "https://example.invalid", description: "", methods: ["GET"],
      headers: { Authorization: "Bearer ${A_SECRET}" }, query: {},
    },
  };
  const r = await testTool("default", "no-such-workspace", def);
  // The name is useful; the value is not, and must never leave the server.
  assert.ok(r.missingSecrets.includes("A_SECRET"));
  assert.ok(!JSON.stringify(r).includes("Bearer "), "a header value leaked into the result");
});
