// An agent file whose frontmatter lost its opening `---` reads as prose: no
// tools, the default model. seo-digest's editor, 20 Sep to 5 Oct 2026.
//
//   node --test tests/unopened-frontmatter.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { deployIssues, unopenedFrontmatter } from "../src/deploy.ts";

const broken = "name: editor\ndescription: Writes the digest.\n# a comment\nmodel: max\ntools: [desks, write]\n---\n\nYou write the digest.\n";

test("a block of key: value lines closed by --- with no opening --- is reported", () => {
  assert.match(unopenedFrontmatter(broken) ?? "", /no opening `---`/);
  const issues = deployIssues([{ path: "agents/editor/agent.md", content: broken }]);
  assert.ok(issues.some((i) => i.where === "agents/editor/agent.md" && /no opening/.test(i.message)), JSON.stringify(issues));
});

test("proper frontmatter, no frontmatter, and prose with a rule are fine", () => {
  assert.equal(unopenedFrontmatter("---\nname: editor\n---\nYou write.\n"), null);
  assert.equal(unopenedFrontmatter("You write the digest.\n"), null);
  assert.equal(unopenedFrontmatter("You write the digest.\n\n---\n\nThen stop.\n"), null);
  assert.equal(unopenedFrontmatter("Note: this is prose.\nAnd more prose here.\n---\n"), null);
});
