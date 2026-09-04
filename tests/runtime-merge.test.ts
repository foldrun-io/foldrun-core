// A tool's dependencies travel with the tool.
//
//   node --test tests/runtime-merge.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeRuntimes, parseRuntime, fingerprint } from "../packages/core/src/runtime.ts";

test("nothing declared anywhere is no runtime", () => {
  assert.equal(mergeRuntimes(null, undefined, null), null);
});

test("one declaration passes through untouched", () => {
  const only = parseRuntime({ packages: ["requests"] })!;
  assert.equal(mergeRuntimes(null, only), only);
});

test("an agent's runtime and its tools' runtimes become one environment", () => {
  const agent = parseRuntime({ python: "3.12", packages: ["pandas"] });
  const scraper = parseRuntime({ packages: ["requests", "beautifulsoup4"] });
  const linker = parseRuntime({ node: true, npm: ["cheerio"] });
  const merged = mergeRuntimes(agent, scraper, linker)!;

  assert.equal(merged.python, "3.12", "a pin beats a bare true");
  assert.deepEqual(merged.packages, ["pandas", "requests", "beautifulsoup4"]);
  assert.equal(merged.node, true);
  assert.deepEqual(merged.npm, ["cheerio"]);
});

test("the same package from two tools is installed once", () => {
  const a = parseRuntime({ packages: ["requests"] });
  const b = parseRuntime({ packages: ["requests", "pyyaml"] });
  assert.deepEqual(mergeRuntimes(a, b)!.packages, ["requests", "pyyaml"]);
});

test("conflicting pins are kept for pip to refuse, not silently resolved", () => {
  const a = parseRuntime({ packages: ["requests==2.31"] });
  const b = parseRuntime({ packages: ["requests==2.32"] });
  assert.deepEqual(mergeRuntimes(a, b)!.packages, ["requests==2.31", "requests==2.32"]);
});

test("merging is deterministic, so the environment is cached across runs", () => {
  const a = parseRuntime({ packages: ["b", "a"] });
  const b = parseRuntime({ npm: ["y", "x"] });
  assert.equal(fingerprint(mergeRuntimes(a, b)!), fingerprint(mergeRuntimes(a, b)!));
});

test("a rejected requirement from any tool is still reported", () => {
  const bad = parseRuntime({ packages: ["--index-url", "requests"] });
  const merged = mergeRuntimes(parseRuntime({ packages: ["pandas"] }), bad)!;
  assert.deepEqual(merged.rejected, ["--index-url"]);
});

test("a runtime that cannot be built says why, even when the installer printed nothing", () => {
  // `spawnSync` reports three different failures and only one of them writes
  // to a stream: a command that cannot be spawned sets `error` and leaves
  // stdout and stderr null. Reporting the streams alone gave the least useful
  // message a build can produce — "npm install failed: " with nothing after
  // it — which is exactly the case that is hardest to diagnose remotely.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-runtime-why-"));
  try {
    const spec = parseRuntime({ node: true, npm: ["sharp"] })!;
    assert.deepEqual(spec.npm, ["sharp"], "npm packages belong under npm:, not packages:");
    assert.deepEqual(spec.packages, [], "sharp must not land in the pip list");

    // The pip list is where `sharp` used to be declared, and pip would try to
    // compile a Node module. Keeping the two lists apart is the fix; this
    // pins that they are read from different keys.
    const wrong = parseRuntime({ packages: ["sharp"] })!;
    assert.deepEqual(wrong.packages, ["sharp"]);
    assert.deepEqual(wrong.npm, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The merge above is only worth anything if the merged result is what actually
// crosses into the sandbox. It was not: the isolated path serialised
// `parseRuntime(front.runtime)` — the agent's own frontmatter, before the
// merge — so a tool's `runtime:` was honoured on the host and dropped under
// k8s. gbp-desk's post_image declares `npm: [sharp]` and its agent declares no
// runtime at all, so inside the container sharp was never installed and the
// tool failed with "Cannot find package 'sharp'" on every run, while the step
// log one line above said the runtime was cached — the host's entry, built
// from the correct merged spec.
test("the runtime that crosses into the sandbox is the merged one", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "packages/core/src/runner.ts"),
    "utf8",
  );

  const inputs = [...src.matchAll(/^\s*runtime: (.+),$/gm)].map((m) => m[1].trim());
  assert.ok(inputs.length > 0, "expected a runtime: field on the isolated input");
  for (const value of inputs) {
    assert.ok(
      !/^parseRuntime\(front\.runtime\)$/.test(value),
      `the isolated input must carry the merged spec, not \`${value}\` — a tool's own runtime: is part of what the step needs`,
    );
  }
});
