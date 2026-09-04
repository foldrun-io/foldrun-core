// `tools:` is the one list; `use:` is gone.
//
// The grant path always read `tools:`; three side-paths — the sandbox's
// network flag, the library's used-by list, Tool Test's agent picker — read
// the old `use:` key alone. So `tools: [read, site_repo]` granted site_repo,
// then ran it with egress off and listed nobody as depending on it. Now one
// resolver answers "which of these names are the author's own?" for all of
// them, and a file that still says `use:` gets an error, not a silent grant.
//
//   node --test tests/tool-names.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownToolNames, isRuntimeTool, legacyUseNames, legacyUseError } from "../packages/core/src/tool-names.ts";
import { libraryUsage } from "../packages/core/src/library.ts";
import { listAgents } from "../packages/core/src/store.ts";
import { convert } from "../scripts/migrate-use-to-tools.mjs";

test("a built-in name is never one of the author's own", () => {
  for (const name of ["read", "files", "bash", "web", "fetch", "search", "history", "Read", "Bash", "WebFetch"]) {
    assert.ok(isRuntimeTool(name), `${name} is a runtime tool`);
  }
  assert.ok(!isRuntimeTool("site_repo"));
});

test("own tools are whatever in tools: a built-in does not claim", () => {
  assert.deepEqual(ownToolNames({ tools: ["read", "site_repo", { internal_links: "ask" }, "site_repo"] }), [
    "site_repo",
    "internal_links",
  ]);
  // Only built-ins means nothing of the author's — the sandbox stays offline.
  assert.deepEqual(ownToolNames({ tools: ["read", "bash"] }), []);
  assert.deepEqual(ownToolNames({}), []);
  // A non-list is ignored rather than crashing the parse.
  assert.deepEqual(ownToolNames({ tools: "read" }), []);
});

test("use: grants nothing and is reported with the line to write", () => {
  assert.deepEqual(ownToolNames({ tools: ["read"], use: ["crm"] }), []);
  assert.deepEqual(legacyUseNames({ use: ["crm", "site_repo"] }), ["crm", "site_repo"]);
  assert.deepEqual(legacyUseNames({ tools: ["crm"] }), []);
  assert.match(legacyUseError(["crm", "site_repo"]), /tools: \[crm, site_repo\]/);
});

/** Build a throwaway account on disk and point core at it for one callback. */
function withAccount(files: Record<string, string>, run: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-toolnames-"));
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

const tool = (name: string) =>
  `---\nkind: Tool\ntransport: http\nname: ${name}\ndescription: t\nbase: https://example.com\nmethods: [GET]\n---\n`;

test("the library and the agent record see a tools: grant; a use: line is flagged, not counted", () => {
  withAccount(
    {
      "acme/library/tools/billing.md": tool("billing"),
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      "acme/workspaces/desk/agents/one-list/agent.md":
        "---\nname: one-list\ndescription: t\ntools: [read, billing]\n---\n\nwork.\n",
      "acme/workspaces/desk/agents/stale/agent.md":
        "---\nname: stale\ndescription: t\ntools: [read]\nuse: [billing]\n---\n\nwork.\n",
    },
    () => {
      // Used-by is the blast radius of rotating a credential: the agent that
      // granted it, and not the one whose grant is under the dead key.
      const used = libraryUsage("acme", "tools", "billing")
        .filter((u) => u.relation === "use")
        .map((u) => u.agent);
      assert.deepEqual(used, ["one-list"]);

      const byName = Object.fromEntries(listAgents("acme", "desk").map((a) => [a.name, a]));
      assert.deepEqual(byName["one-list"].ownTools, ["billing"]);
      assert.deepEqual(byName["one-list"].legacyUse, []);
      assert.deepEqual(byName.stale.ownTools, []);
      assert.deepEqual(byName.stale.legacyUse, ["billing"]);
    },
  );
});

// The converter is what makes "use: is gone" survivable: every shape an
// agent was written in comes out as a `tools:` list, byte-identical
// elsewhere.
test("the migration merges use: into tools: in whichever form tools: already has", () => {
  // Inline into inline, comment kept.
  assert.equal(
    convert("---\nname: a\ntools: [read] # look only\nuse: [site_repo, internal_links]\nsize: small\n---\n\nbody\n"),
    "---\nname: a\ntools: [read, site_repo, internal_links] # look only\nsize: small\n---\n\nbody\n",
  );
  // Block into block, indent matched, duplicates dropped.
  assert.equal(
    convert("---\nname: a\ntools:\n  - files\n  - wordcount\nuse:\n  - wordcount\n  - crm\n---\n"),
    "---\nname: a\ntools:\n  - files\n  - wordcount\n  - crm\n---\n",
  );
  // No tools: at all — a fresh list where use: stood.
  assert.equal(
    convert("---\nname: a\nuse: [crm]\nsecrets: [T]\n---\n\nbody\n"),
    "---\nname: a\ntools: [crm]\nsecrets: [T]\n---\n\nbody\n",
  );
  // Map-form entries in tools: are recognised as already present.
  assert.equal(
    convert("---\ntools: [{bash: ask}, read]\nuse: [bash-ish]\n---\n"),
    "---\ntools: [{bash: ask}, read, bash-ish]\n---\n",
  );
  // Nothing to do, nothing touched — including a body that mentions the word.
  assert.equal(convert("---\nname: a\ntools: [read]\n---\n\nuse: this wisely\n"), null);
  assert.equal(convert("no frontmatter\nuse: [x]\n"), null);
});
