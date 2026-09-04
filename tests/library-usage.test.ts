// What depends on a shared file.
//
// This test could not be written before `dataRoot()` existed: the data
// directory was captured into a module-level const at import time, so pointing
// core at a fixture directory after importing it silently read the wrong root
// and returned nothing. An empty result reads as "no consumers" rather than
// "wrong directory", which is the failure mode worth designing out.
//
//   node --test tests/library-usage.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { libraryTools, libraryUsage, listLibrary, type LibraryUse } from "../packages/core/src/library.ts";
import { brokenToolReport, workspaceTools } from "../packages/core/src/store.ts";
import { commandFor } from "../packages/core/src/script-tools.ts";

/** Build a throwaway account on disk and point core at it for one callback. */
function withAccount(files: Record<string, string>, run: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-usage-"));
  const previous = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    run();
  } finally {
    if (previous === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const agent = (name: string, use?: string) =>
  `---\nkind: Agent\nname: ${name}\ndescription: t\n${use ? `tools: [${use}]\n` : ""}---\n\nwork.\n`;

const tool = (name: string) =>
  `---\nkind: Tool\ntransport: http\nname: ${name}\ndescription: t\nbase: https://example.com\nmethods: [GET]\n---\n`;

const sorted = (u: LibraryUse[]) =>
  [...u].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test("a library tool is traced to the agents that opted in", () => {
  withAccount(
    {
      "acme/library/tools/billing.md": tool("billing"),
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/agents/writer/agent.md": agent("writer", "billing"),
      "acme/workspaces/desk/agents/idle/agent.md": agent("idle"),
      "acme/workspaces/other/AGENTS.md": "---\nname: other\n---\n",
      "acme/workspaces/other/agents/biller/agent.md": agent("biller", "billing"),
    },
    () => {
      // Exactly the agents that named it — across workspaces, and not the one
      // that didn't. This is the blast radius of rotating its credential.
      assert.deepEqual(sorted(libraryUsage("acme", "tools", "billing")), [
        { workspace: "desk", agent: "writer", relation: "use" },
        { workspace: "other", agent: "biller", relation: "use" },
      ]);
    },
  );
});

test("a tool nobody opted into has no consumers", () => {
  withAccount(
    {
      "acme/library/tools/unused.md": tool("unused"),
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/agents/writer/agent.md": agent("writer"),
    },
    () => assert.deepEqual(libraryUsage("acme", "tools", "unused"), []),
  );
});

test("a nearer file of the same name is reported as shadowing", () => {
  // Resolution is nearest-wins, so this is silent: the account file still
  // exists and is not what runs. Both scopes that can override are checked.
  withAccount(
    {
      "acme/library/skills/tone/SKILL.md": "---\nkind: Skill\nname: tone\ndescription: t\n---\n",
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/agents/writer/agent.md": agent("writer"),
      "acme/workspaces/desk/skills/tone/SKILL.md": "---\nkind: Skill\nname: tone\ndescription: w\n---\n",
      "acme/workspaces/desk/agents/writer/skills/tone/SKILL.md":
        "---\nkind: Skill\nname: tone\ndescription: a\n---\n",
    },
    () => {
      assert.deepEqual(sorted(libraryUsage("acme", "skills", "tone")), [
        { workspace: "desk", agent: "writer", relation: "shadowed" },
        { workspace: "desk", agent: null, relation: "shadowed" },
      ]);
    },
  );
});

test("a tool can be used and shadowed at once", () => {
  // The case that most needs saying out loud: an agent opted in by name, and
  // a workspace file of that name is what it actually gets.
  withAccount(
    {
      "acme/library/tools/billing.md": tool("billing"),
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/agents/writer/agent.md": agent("writer", "billing"),
      "acme/workspaces/desk/tools/billing.md": tool("billing"),
    },
    () => {
      assert.deepEqual(sorted(libraryUsage("acme", "tools", "billing")), [
        { workspace: "desk", agent: "writer", relation: "use" },
        { workspace: "desk", agent: null, relation: "shadowed" },
      ]);
    },
  );
});

test("knowledge and memory report shadowing but never use", () => {
  // They are indexed for every agent in scope with no opt-in, so "used by"
  // would be "everyone" — true, and not information.
  withAccount(
    {
      "acme/library/knowledge/pricing.md": "---\ntype: Price List\nname: pricing\n---\n",
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/agents/writer/agent.md": agent("writer"),
      "acme/workspaces/desk/knowledge/pricing.md": "---\ntype: Price List\nname: pricing\n---\n",
    },
    () => {
      const uses = libraryUsage("acme", "knowledge", "pricing");
      assert.deepEqual(uses, [{ workspace: "desk", agent: null, relation: "shadowed" }]);
      assert.equal(uses.filter((u) => u.relation === "use").length, 0);
    },
  );
});

test("the data root is read per call, not captured at import", () => {
  // The regression that made this file impossible to write. If dataRoot() is
  // ever hoisted back into a const, the second account below reads the first.
  let first: LibraryUse[] = [];
  withAccount(
    {
      "acme/library/tools/billing.md": tool("billing"),
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/agents/writer/agent.md": agent("writer", "billing"),
    },
    () => (first = libraryUsage("acme", "tools", "billing")),
  );
  assert.equal(first.length, 1);

  withAccount(
    {
      "acme/library/tools/billing.md": tool("billing"),
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/agents/writer/agent.md": agent("writer"),
    },
    () => assert.deepEqual(libraryUsage("acme", "tools", "billing"), []),
  );
});

// ------------------------------------------------- tools list their shape

test("a tools listing says how each tool connects, and what a script one runs", () => {
  withAccount(
    {
      "acme/library/tools/api.md": "---\nname: api\nbase: https://example.com\n---\n",
      "acme/library/tools/code.md":
        "---\ntransport: script\nname: code\nrun: account/scripts/x.mjs\n---\n",
      "acme/library/tools/broken.md": "---\nname: broken\n---\nno base, no run\n",
    },
    () => {
      const byName = new Map(listLibrary("acme", "tools").map((e) => [e.name, e]));
      assert.equal(byName.get("api")!.transport, "http");
      assert.equal(byName.get("code")!.transport, "script");
      // The link between the two shelves, shown rather than inferred.
      assert.equal(byName.get("code")!.runs, "account/scripts/x.mjs");
      // A definition the runner would reject gets no badge, and does not
      // take the page down with it.
      assert.equal(byName.get("broken")?.transport, undefined);
    },
  );
});

test("a tool with broken frontmatter is reported, not silently missing", () => {
  withAccount(
    {
      // The exact shape that cost two runs to diagnose: a value beginning
      // with a quoted scalar, which YAML reads as a scalar followed by junk.
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/tools/typo.md":
        '---\ntransport: script\nname: typo\nrun: run.mjs\nargs:\n  flag: "true" to do the thing\n---\n',
    },
    () => {
      // It does not load — that part is correct, a definition we cannot parse
      // is one we must not hand to an agent.
      assert.equal(workspaceTools("acme", "desk").typo, undefined);
      // But it does not vanish either.
      const broken = brokenToolReport("acme", "desk");
      assert.equal(broken.length, 1);
      assert.match(broken[0], /^typo: /);
    },
  );
});

test("a folder tool is one entry in the listing, not two files", () => {
  withAccount(
    {
      "acme/library/tools/browser/tool.md":
        "---\ntransport: script\nname: browser\ndescription: renders a page\nrun: run.mjs\n---\n",
      "acme/library/tools/browser/run.mjs": "console.log('hi')\n",
      "acme/library/tools/email.md":
        "---\nname: email\ndescription: sends mail\nbase: https://api.resend.com\n---\n",
    },
    () => {
      const entries = listLibrary("acme", "tools");
      // Two tools, not three rows — run.mjs is the browser's code, and
      // listing it separately claims a tool nobody can grant.
      assert.deepEqual(
        entries.map((e) => e.name).sort(),
        ["browser", "email"],
      );
      const browser = entries.find((e) => e.name === "browser")!;
      assert.equal(browser.path, "browser/tool.md");
      assert.equal(browser.transport, "script");
    },
  );
});

test("a single-file script tool runs its fenced code block", () => {
  withAccount(
    {
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/tools/echoer.md": [
        "---",
        "transport: script",
        "name: echoer",
        "description: echoes",
        "args:",
        "  input: what to echo",
        "---",
        "",
        "Usage example (must never be mistaken for the program):",
        "",
        "```yaml",
        "tools: [echoer]",
        "```",
        "",
        "```js",
        "console.log('from-the-fence');",
        "```",
        "",
      ].join("\n"),
    },
    () => {
      const def = workspaceTools("acme", "desk").echoer;
      assert.ok(def, "single-file script tool parses");
      assert.equal(def.kind, "script");
      const spec = def.spec as { code?: string };
      assert.match(spec.code!, /from-the-fence/);
      assert.doesNotMatch(spec.code!, /tools: \[echoer\]/);
    },
  );
});

// The bug this pins, found by migrating a live account to folder tools.
//
// gray-matter caches its parse by the input string, so two byte-identical
// definitions — the same gallery tool installed at the account AND in a
// workspace, which is the ordinary case — are handed the SAME `data` object.
// readToolDir qualifies a folder tool's `run:` with its scope by mutating
// that object, so the first read stamped its scope onto the second: the
// account's copy came back `workspace/tools/browser/run.mjs`, resolved into
// whichever workspace happened to be read first, and found nothing there.
//
// Silent, and dependent on read order. The tool simply stopped working.
test("the same tool at two scopes keeps its own run: path", () => {
  const definition = [
    "---",
    "transport: script",
    "name: browser",
    "run: run.mjs",
    "description: Byte-identical to the account's copy, which is the point.",
    "---",
    "",
    "The program is beside this file.",
    "",
  ].join("\n");

  withAccount(
    {
      "acme/library/tools/browser/tool.md": definition,
      "acme/library/tools/browser/run.mjs": "console.log('{}')\n",
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/tools/browser/tool.md": definition,
      "acme/workspaces/desk/tools/browser/run.mjs": "console.log('{}')\n",
    },
    () => {
      // Workspace first, then account — the order the runner uses, and the
      // one that used to poison the second read.
      const inWorkspace = workspaceTools("acme", "desk").browser;
      const inLibrary = libraryTools("acme").browser;
      assert.equal(inWorkspace.spec.run, "workspace/tools/browser/run.mjs");
      assert.equal(
        inLibrary.spec.run,
        "account/tools/browser/run.mjs",
        "the account's copy was stamped with the workspace's scope",
      );

      // And the other order, so neither read can poison the other.
      assert.equal(libraryTools("acme").browser.spec.run, "account/tools/browser/run.mjs");
      assert.equal(workspaceTools("acme", "desk").browser.spec.run, "workspace/tools/browser/run.mjs");
    },
  );
});

// The Test-tool button and a real run must choose the same interpreter.
//
// They did not: the tester carried its own shorter table, which knew `.js`
// but not `.mjs`, so it spawned the program as an executable and reported
// EACCES for a tool that runs correctly. Every extracted tool defaults to
// run.mjs, so the button broke for all of them at once.
test("the tester and the runner pick the same interpreter", () => {
  for (const [file, cmd] of [
    ["/w/tools/x/run.mjs", "node"],
    ["/w/tools/x/run.js", "node"],
    ["/w/tools/x/run.py", "python3"],
    ["/w/tools/x/run.sh", "bash"],
    ["/w/tools/x/run.rb", "ruby"],
  ] as const) {
    const chosen = commandFor(
      { name: "x", run: file, description: "", args: {} },
      file,
    );
    assert.equal(chosen.cmd, cmd, `${file} should run under ${cmd}`);
    assert.deepEqual(chosen.args, [file]);
  }

  // A declared interpreter still wins over the extension.
  const pinned = commandFor(
    { name: "x", run: "run.mjs", description: "", args: {}, interpreter: "bun" },
    "/w/tools/x/run.mjs",
  );
  assert.equal(pinned.cmd, "bun");
});
