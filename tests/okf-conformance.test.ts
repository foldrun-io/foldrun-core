// Would somebody else's OKF validator accept a bundle we emit?
//
// That is a different question from "does our reader like it", and the two had
// been conflated. We reserved a third filename of our own, MEMORY.md, and put
// it in the same set as the spec's two — so the conformance check skipped a
// file every other consumer reads as a concept and requires a `type` on. The
// name is gone now; these tests hold the line that the reserved set is the
// spec's and nothing of ours is added to it.
//
// These tests apply the spec's rules rather than ours, quoted from
// GoogleCloudPlatform/knowledge-catalog okf/SPEC.md v0.2 §Conformance:
//
//   1. every non-reserved .md file contains parseable YAML frontmatter
//   2. every frontmatter block contains a non-empty `type` field
//   3. reserved filenames follow their defined structures
//   · consumers MUST NOT reject a bundle for missing optional fields, unknown
//     `type` values, unknown additional keys, or broken cross-links
//
//   node --test tests/okf-conformance.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { conformanceIssues, syncIndex } from "../packages/core/src/okf.ts";

/** OKF reserves these two, and only these two. */
const RESERVED = new Set(["index.md", "log.md"]);

function withBundle(files: Record<string, string>, run: (dir: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-okf-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** An independent validator: the spec's rules, not this platform's. */
function validate(dir: string, prefix = ""): string[] {
  const problems: string[] = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      problems.push(...validate(full, `${prefix}${entry}/`));
      continue;
    }
    if (!entry.endsWith(".md")) continue;
    const raw = fs.readFileSync(full, "utf8");

    if (RESERVED.has(entry)) {
      // §8: index.md carries no frontmatter except okf_version at a root.
      const front = matter(raw).data as Record<string, unknown>;
      const extra = Object.keys(front).filter((k) => k !== "okf_version");
      if (entry === "index.md" && extra.length) {
        problems.push(`${prefix}${entry}: index.md carries ${extra.join(", ")}`);
      }
      continue;
    }
    let data: Record<string, unknown>;
    try {
      data = matter(raw).data as Record<string, unknown>;
    } catch {
      problems.push(`${prefix}${entry}: frontmatter does not parse`);
      continue;
    }
    if (!(typeof data.type === "string" && data.type.trim())) {
      problems.push(`${prefix}${entry}: no non-empty \`type\``);
    }
  }
  return problems;
}

const CONCEPT = `---
type: Fact
title: Pricing
---

Base price is 400.
`;

test("a bundle of typed concepts satisfies an outside validator", () => {
  withBundle({ "memory/pricing.md": CONCEPT }, (root) => {
    const dir = path.join(root, "memory");
    syncIndex(dir, "Memory", true);
    assert.deepEqual(validate(dir), []);
  });
});

// §Conformance is explicit that these four are not grounds for rejection, and
// it is the reason our own `name:` can sit beside OKF's `title:`.
test("unknown keys, unknown types and broken links are not rejections", () => {
  withBundle(
    {
      "memory/odd.md": `---
type: Something We Invented
name: odd
foldrun_only_key: true
---

See [[nothing-here]].
`,
    },
    (root) => {
      const dir = path.join(root, "memory");
      assert.deepEqual(validate(dir), []);
      assert.deepEqual(conformanceIssues(dir), []);
    },
  );
});

test("a nested section is validated too — the path is the identity", () => {
  withBundle({ "memory/tables/orders.md": "---\ntitle: Orders\n---\n\nNo type.\n" }, (root) => {
    const dir = path.join(root, "memory");
    assert.deepEqual(conformanceIssues(dir).map((i) => i.file), ["tables/orders.md"]);
  });
});

test("unparseable frontmatter is reported, not thrown", () => {
  withBundle({ "memory/broken.md": "---\ntype: [unclosed\n---\n\nBody.\n" }, (root) => {
    const dir = path.join(root, "memory");
    const issues = conformanceIssues(dir);
    assert.equal(issues.length, 1);
    assert.match(issues[0].issue, /parse/);
  });
});

// A concept with a `type` is conformant on its own, but a *bundle* is only
// self-describing once its root index.md carries okf_version — the first thing
// a consumer reads. Both scaffold paths wrote their starter files straight to
// disk, so a brand-new workspace shipped valid concepts inside something no
// reader could identify the version of. The demo is the first OKF anyone sees.
test("a freshly scaffolded workspace is a valid bundle, not just valid files", async () => {
  const { starterFiles, syncWorkspaceBundles } = await import("../packages/core/src/okf.ts").then(
    async (okf) => ({ ...okf, ...(await import("../packages/core/src/starter.ts")) }),
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-scaffold-"));
  try {
    for (const { path: rel, content } of starterFiles("demo")) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    syncWorkspaceBundles(root);

    for (const kind of ["knowledge", "memory"]) {
      const dir = path.join(root, kind);
      assert.ok(fs.existsSync(dir), `the starter ships no ${kind}/ — half of OKF goes undemonstrated`);
      assert.deepEqual(validate(dir), [], `${kind}/ fails an outside validator`);

      const index = path.join(dir, "index.md");
      assert.ok(fs.existsSync(index), `${kind}/index.md was never generated`);
      assert.match(
        fs.readFileSync(index, "utf8"),
        /okf_version: "0\.2"/,
        `${kind}/ declares no okf_version, so nothing says which format it targets`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The rule that replaces the MEMORY.md special case: a file we invent inside
// someone else's format is a concept like any other. It gets no exemption from
// `type`, and it is not hidden from listings — because a consumer applying the
// spec's reserved set will do neither of those things for us.
test("a filename of our own earns no exemption from the spec's rules", () => {
  withBundle(
    { "memory/MEMORY.md": "# Memory\n\n- curated notes\n", "memory/pricing.md": CONCEPT },
    (root) => {
      const dir = path.join(root, "memory");
      // Reported, with the ordinary message — no special case, no repair.
      assert.deepEqual(
        conformanceIssues(dir).map((i) => i.file),
        ["MEMORY.md"],
      );
      assert.deepEqual(validate(dir), ["MEMORY.md: no non-empty `type`"]);
    },
  );
});

test("only index.md and log.md are treated as bundle structure", () => {
  withBundle(
    {
      "memory/pricing.md": CONCEPT,
      "memory/index.md": '---\nokf_version: "0.2"\n---\n\n# Memory\n',
      "memory/log.md": "# Log\n",
    },
    (root) => {
      const dir = path.join(root, "memory");
      assert.deepEqual(conformanceIssues(dir), [], "the spec's two carry no type and are fine");
      assert.deepEqual(validate(dir), []);
    },
  );
});
