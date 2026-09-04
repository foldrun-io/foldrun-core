// The templates that ship.
//
// Two places hold a workspace and they are not the same thing:
//
//   templates/<name>/                  authored, committed, shipped
//   data/<tenant>/workspaces/<name>/  created at runtime, gitignored
//
// The second holds user content — secrets, run journals, memory an agent
// wrote — and can never be committed. The first is reference material a reader
// clones, so it has to be correct without anyone running it. Nothing enforced
// that, and it showed: the one workspace that actually ships had a knowledge/
// with a conformant concept and no index.md, so the example of a bundle was
// not a bundle.
//
// These are the checks a reader would perform, run before they can.
//
//   node --test tests/templates.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  conformanceIssues,
  dateIssues,
  syncWorkspaceBundles,
} from "../packages/core/src/okf.ts";

const ROOT = path.join(import.meta.dirname, "..");
const TEMPLATES = path.join(ROOT, "templates");

const templates = fs
  .readdirSync(TEMPLATES)
  .filter((n) => fs.statSync(path.join(TEMPLATES, n)).isDirectory());

/** Every OKF bundle in a workspace, at both scopes. */
function bundles(root: string): string[] {
  const out: string[] = [];
  for (const kind of ["knowledge", "memory"]) {
    const dir = path.join(root, kind);
    if (fs.existsSync(dir)) out.push(dir);
    const agents = path.join(root, "agents");
    if (!fs.existsSync(agents)) continue;
    for (const agent of fs.readdirSync(agents)) {
      const nested = path.join(agents, agent, kind);
      if (fs.existsSync(nested)) out.push(nested);
    }
  }
  return out;
}

test("there is at least one template to ship", () => {
  assert.ok(templates.length > 0, "templates/ is empty");
});

for (const name of templates) {
  const root = path.join(TEMPLATES, name);

  test(`${name}: every bundle is conformant`, () => {
    for (const dir of bundles(root)) {
      assert.deepEqual(
        conformanceIssues(dir),
        [],
        `${path.relative(ROOT, dir)} would be rejected by an outside validator`,
      );
      assert.deepEqual(dateIssues(dir), [], `${path.relative(ROOT, dir)} has an unusable date`);
    }
  });

  // The failure this exists for: an example is edited by hand in a pull
  // request, and the generated index that ships beside it still describes the
  // file as it was. A reader clones a bundle whose index disagrees with its
  // own contents, and nothing anywhere says so.
  test(`${name}: the committed indexes are current`, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `foldrun-ex-${name}-`));
    try {
      fs.cpSync(root, tmp, { recursive: true });
      syncWorkspaceBundles(tmp);

      for (const dir of bundles(root)) {
        const rel = path.relative(root, dir);
        for (const reserved of ["index.md", "log.md"]) {
          const committed = path.join(dir, reserved);
          const regenerated = path.join(tmp, rel, reserved);
          if (!fs.existsSync(committed) && !fs.existsSync(regenerated)) continue;
          assert.equal(
            fs.existsSync(committed) ? fs.readFileSync(committed, "utf8") : null,
            fs.existsSync(regenerated) ? fs.readFileSync(regenerated, "utf8") : null,
            `${path.join(rel, reserved)} is stale — re-sync the bundle and commit the result`,
          );
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // A workspace with no agent runs nothing, and an eval or flow naming an
  // agent that isn't there is a broken example that still looks complete.
  test(`${name}: names only things it contains`, () => {
    const agents = path.join(root, "agents");
    assert.ok(fs.existsSync(agents), "a template needs at least one agent");
    const names = new Set(fs.readdirSync(agents));

    const flows = path.join(root, "flows");
    if (!fs.existsSync(flows)) return;
    for (const file of fs.readdirSync(flows).filter((f) => f.endsWith(".md"))) {
      const raw = fs.readFileSync(path.join(flows, file), "utf8");
      for (const [, target] of raw.matchAll(/\[\[(?!flow:)([a-z0-9-]+)\]\]/g)) {
        assert.ok(names.has(target), `flows/${file} names [[${target}]], which does not exist`);
      }
    }
  });
}
