// `[[name]]` in frontmatter — the last place a name had to be bare.
//
// YAML turns `- [[site_repo]]` into a nested list, so every reader of a
// file-naming field goes through one function that knows an array entry
// was a link. These pin the shapes, the one place linked-ness matters (a
// linked tool is the author's even when a built-in has the same name), and
// that the store, the runner's grant list and the editor all agree.
//
//   node --test tests/refs.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { refList, refNames, stripLink } from "../packages/core/src/refs.ts";
import { ownToolNames, toolRefs } from "../packages/core/src/tool-names.ts";
import { listAgents, parseFlow } from "../packages/core/src/store.ts";
import { completionsAt, type Vocabulary } from "../packages/core/src/completions.ts";

test("every shape a list can arrive in reads to the same names", () => {
  // What gray-matter hands back for each spelling.
  const { data } = matter(
    [
      "---",
      "inline: [read, [[site_repo]], {bash: ask}]",
      "block:",
      "  - files",
      "  - [[house-style]]",
      '  - "[[quoted]]"',
      "single: [[flow:weekly]]",
      "comma: Read, Grep",
      "one: writer",
      "---",
    ].join("\n"),
  );
  assert.deepEqual(refList(data.inline), [
    { name: "read", linked: false, mode: null },
    { name: "site_repo", linked: true, mode: null },
    { name: "bash", linked: false, mode: "ask" },
  ]);
  assert.deepEqual(refList(data.block), [
    { name: "files", linked: false, mode: null },
    { name: "house-style", linked: true, mode: null },
    { name: "quoted", linked: true, mode: null },
  ]);
  assert.deepEqual(refList(data.single), [{ name: "flow:weekly", linked: true, mode: null }]);
  // Claude Code's comma string, unchanged.
  assert.deepEqual(refNames(data.comma), ["Read", "Grep"]);
  assert.deepEqual(refNames(data.one), ["writer"]);
  assert.deepEqual(refNames(undefined), []);
  assert.deepEqual(refNames(null), []);
  assert.deepEqual(refNames([null, "", [[]]]), []);
  assert.deepEqual(stripLink("  [[ a ]] "), { name: "a", linked: true });
});

test("a linked tool is the author's even when a built-in has the name", () => {
  const { data } = matter("---\ntools: [search, [[search]], read, [[site_repo]]]\n---\n");
  const refs = toolRefs(data);
  assert.deepEqual(
    refs.map((r) => [r.name, r.linked]),
    [["search", false], ["search", true], ["read", false], ["site_repo", true]],
  );
  // Bare `search` is the platform group; `[[search]]` is a tools/search.md
  // of yours — the only way such a tool can be granted at all.
  assert.deepEqual(ownToolNames(data), ["search", "site_repo"]);
  assert.deepEqual(ownToolNames({ tools: ["search", "read"] }), []);
});

/** Build a throwaway account on disk and point core at it for one callback. */
function withAccount(files: Record<string, string>, run: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-refs-"));
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

test("the agent record reads linked and bare entries as the same list", () => {
  withAccount(
    {
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/agents/linker/agent.md":
        "---\nname: linker\ndescription: t\ntools:\n  - read\n  - [[site_repo]]\n  - [[search]]\n---\n\nwork.\n",
    },
    () => {
      const [a] = listAgents("acme", "desk");
      assert.deepEqual(a.tools, ["read", "site_repo", "search"]);
      assert.deepEqual(a.ownTools, ["site_repo", "search"]);
    },
  );
});

test("after: reads a link, a flow: link, or a bare name", () => {
  for (const [spelling, want] of [
    ["after: [[flow:publish]]", "publish"],
    ["after: [[publish]]", "publish"],
    ["after: publish", "publish"],
    ["after: flow:publish", "publish"],
  ] as const) {
    const flow = parseFlow("flows/x.md", `---\ntrigger: after\n${spelling}\n---\n\n1. [[writer]] — go\n`);
    assert.equal(flow.after, want, spelling);
  }
});

const VOCAB: Vocabulary = {
  agents: ["enricher", "emailer"],
  flows: ["weekly"],
  skills: ["outreach", "house-style"],
  tools: ["site_repo", "search"],
  secrets: [],
  scripts: [],
  types: [],
  docs: [{ name: "sources", hint: "knowledge" }],
};
const at = (text: string) => completionsAt("agents/dev/agent.md", text, text.length, VOCAB);

test("[[ inside a file-naming list offers that field's files, closing the link", () => {
  // Inline, with a built-in already chosen: only your tools, never groups.
  let labels = at("---\ntools: [read, [[")!.items.map((i) => i.label);
  assert.deepEqual(labels, ["site_repo", "search"]);
  assert.equal(at("---\ntools: [read, [[si")!.items[0].insert, "site_repo]]");
  // Block form looks upward for the owner.
  labels = at("---\nskills:\n  - [[ho")!.items.map((i) => i.label);
  assert.deepEqual(labels, ["house-style"]);
  labels = at("---\nagents:\n  - [[")!.items.map((i) => i.label);
  assert.deepEqual(labels, ["enricher", "emailer"]);
  // after: is a single value, and it wants flows.
  labels = at("---\nafter: [[")!.items.map((i) => i.label);
  assert.deepEqual(labels, ["flow:weekly"]);
  // Outside a list the bracket still offers everything — prose is unchanged.
  labels = at("---\nname: x\n---\n\nRead [[")!.items.map((i) => i.label);
  assert.ok(labels.includes("sources") && labels.includes("enricher") && labels.includes("flow:weekly"));
});
