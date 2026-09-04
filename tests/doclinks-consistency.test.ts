// One reference syntax, one rule about it.
//
// [[ ]] is offered by the editor in every document, and that is deliberate: a
// link between documents is worth writing whether or not a model expands it.
// What must not drift is WHERE it expands. The rule is not a directory list —
// it is "does this text become a prompt":
//
//   agent body          → expanded    (runner.ts, agent prompt)
//   step instruction    → expanded    (runner.ts, step prompt)
//   eval task           → expanded    (becomes a step instruction)
//   ask: / approval note→ expanded    (authored by a person, for this run)
//   previous results    → NOT         (model output; brackets it emits are text)
//   knowledge / tools   → NOT         (read as a file; the link is for a reader)
//
// These tests pin both halves: the runtime's behaviour, and the editor's
// claim about it. They failed as a pair when the gate expanded nothing while
// the editor said "Link" in the same voice everywhere.
//
//   node --test tests/doclinks-consistency.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveDocLinks } from "../packages/core/src/runner.ts";
import { linkableDocs } from "../packages/core/src/linkable.ts";
import { completionsAt, resolvesLinks, type Vocabulary } from "../packages/core/src/completions.ts";

const VOCAB: Vocabulary = {
  agents: ["writer"],
  flows: ["publish"],
  skills: [],
  tools: [],
  secrets: [],
  scripts: [],
  types: [],
  docs: [{ name: "house-style", hint: "knowledge" }],
};

/** A workspace with one of everything [[ ]] is meant to reach. */
function withWorkspace(run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-links-"));
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  try {
    write("knowledge/house-style.md", "---\ntitle: How we write\n---\n\nrules.\n");
    write("knowledge/index.md", "---\nokf_version: \"0.2\"\n---\n\n# Knowledge\n");
    write("memory/audience.md", "---\nname: audience\n---\n\nlearned.\n");
    write("storage/conveyancers-enriched.csv", "email\n");
    write("state/dead-ends.csv", "firm,reason\n");
    fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ------------------------------------------------------- the runtime half

test("a person's words at a gate expand, like every other authored instruction", () =>
  withWorkspace((root) => {
    // What someone types answering `ask:` is an instruction aimed at this run.
    // It used to reach the model as two literal brackets.
    const answer = resolveDocLinks("read [[state]] and follow [[house-style]]", root);
    assert.match(answer, /\.\.\/\.\.\/state\//);
    assert.match(answer, /\.\.\/\.\.\/knowledge\/house-style\.md/);
    assert.doesNotMatch(answer, /\[\[/);
  }));

test("an unmatched link is left alone, not mangled into a path", () =>
  withWorkspace((root) => {
    // Agent names, flow links and ordinary prose in brackets all pass through.
    // This is sugar over paths, never a gate in front of them.
    const text = resolveDocLinks("hand to [[writer]] — see [[nothing-like-this]]", root);
    assert.match(text, /\[\[writer\]\]/);
    assert.match(text, /\[\[nothing-like-this\]\]/);
  }));

// ------------------------------------------------------- the editor half

test("the editor offers [[ ]] in every kind of document", () => {
  for (const file of [
    "agents/writer/agent.md",
    "flows/publish.md",
    "evals/quality.md",
    "knowledge/house-style.md",
    "tools/wordcount/tool.md",
  ]) {
    const text = "see [[";
    const ctx = completionsAt(file, text, text.length, VOCAB);
    assert.ok(ctx, `${file} offered nothing`);
    assert.equal(ctx.title.startsWith("Link"), true, `${file} did not offer a link`);
    assert.ok(
      ctx.items.some((i) => i.label === "house-style"),
      `${file} did not offer the workspace's documents`,
    );
  }
});

test("and says which of the two things a link will do here", () => {
  const opened = "see [[";
  const expands = (file: string) => completionsAt(file, opened, opened.length, VOCAB)!.title;

  // Text that becomes a prompt.
  for (const file of ["agents/writer/agent.md", "AGENTS.md", "flows/publish.md", "evals/quality.md"]) {
    assert.equal(resolvesLinks(file), true, file);
    assert.match(expands(file), /expanded to a real path/, file);
  }

  // Text that is read as a file. The link is for the person reading it, and
  // the list should not imply otherwise.
  for (const file of ["knowledge/house-style.md", "memory/log.md", "tools/wordcount/tool.md"]) {
    assert.equal(resolvesLinks(file), false, file);
    assert.match(expands(file), /literal here/, file);
  }
});

// ------------------------------------------------- the two halves agreeing

// The property that makes the feature trustworthy: the editor must never
// suggest a link the runner cannot resolve. It did — the file store was
// offered as `files/x.csv` while the resolver indexed `storage/x.csv`, so
// accepting the suggestion sent two literal brackets to the model. That is
// the second time this exact rename has caused a silent failure, which is
// why the list now has one definition and this test.
test("every link the editor offers is one the runner resolves", () =>
  withWorkspace((root) => {
    const offered = linkableDocs(root, [{ path: "conveyancers-enriched.csv" }]);
    assert.ok(offered.length >= 5, `expected a full workspace, got ${offered.length}`);

    const unresolved: string[] = [];
    for (const doc of offered) {
      const out = resolveDocLinks(`see [[${doc.name}]]`, root);
      if (out.includes("[[")) unresolved.push(doc.name);
    }
    assert.deepEqual(unresolved, [], "offered but not resolvable");

    // And specifically: the file store, under the name the resolver indexes.
    assert.ok(
      offered.some((d) => d.name === "storage/conveyancers-enriched.csv"),
      `the file store was offered as: ${offered.filter((d) => d.hint === "file").map((d) => d.name).join(", ")}`,
    );
    // The folders the resolver has always accepted are now discoverable.
    for (const dir of ["state", "knowledge", "outputs"]) {
      assert.ok(offered.some((d) => d.name === dir), `${dir} was not offered`);
    }
  }));

// A generated index is a view of the bundle, not a concept. Linking one is a
// link to a file that will be rewritten out from under it.
test("generated bundle files are not offered as link targets", () =>
  withWorkspace((root) => {
    const names = linkableDocs(root, []).map((d) => d.name);
    assert.ok(!names.includes("index"), "index.md was offered");
    assert.ok(!names.includes("log"), "log.md was offered");
    assert.ok(names.includes("house-style"), "a real concept was missing");
  }));
