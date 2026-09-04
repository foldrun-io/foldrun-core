// The loop, end to end, with a real model.
//
// Everything else in this suite runs offline: unit checks, static guards, and
// conformance rules applied to files on disk. None of it executes an agent, so
// none of it can catch the failures that only appear when one does — and every
// such bug found so far was found by running the thing and reading what it
// left behind, not by reading the code:
//
//   · the agent was refused the index it was told to start from
//   · nothing it learned ever reached log.md
//   · it wrote `name:` a line after being told to write no frontmatter
//   · it could not find the previous step's output and reported it missing
//
// This test is those readings, written down. It costs money and depends on a
// model, so it is opt-in and skipped by default:
//
//   FOLDRUN_E2E=1 node --test tests/e2e.test.ts
//
// Credentials come from ANTHROPIC_API_KEY or an existing Claude Code login —
// the Agent SDK spawns the Claude Code executable, so a local subscription is
// enough and no key needs to be set.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import matter from "gray-matter";
import { conformanceIssues, readBundle, provenanceMarks, PRODUCER } from "../packages/core/src/okf.ts";

const ROOT = path.join(import.meta.dirname, "..");
const CLI = path.join(ROOT, "packages/cli/bin/foldrun.mjs");

// Opt-in: `npm test` must stay free and offline.
const enabled = process.env.FOLDRUN_E2E === "1";
const opts = { skip: enabled ? false : "set FOLDRUN_E2E=1 to run (spends money)" };

const foldrun = (...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: ROOT });

test("a template runs, and leaves a conformant workspace behind", opts, () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-e2e-"));
  try {
    const created = foldrun("init", ws, "--from", "templates/hello");
    assert.equal(created.status, 0, `init failed:\n${created.stderr}`);

    const run = foldrun("run", "note", "--workspace", ws);
    assert.equal(run.status, 0, `run failed:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /completed/, "the flow did not report completion");

    // What follows separates two kinds of claim, because only one of them is
    // testable. A model chooses what to write and where; the first draft of
    // this test asserted an exact deliverable path and failed on a run where
    // the agent simply did it differently, having reported success. So the
    // agent's *behaviour* is checked loosely — it did the work at all — and
    // the platform's *guarantees* about whatever it produced are checked hard.

    const outputs = path.join(ws, "agents/notetaker/outputs");
    const wrote = fs.existsSync(outputs) ? fs.readdirSync(outputs) : [];
    const memory = path.join(ws, "memory");
    const concepts = readBundle(memory);

    assert.ok(
      wrote.length > 0 || concepts.length > 0,
      "the run reported success and produced nothing at all",
    );

    // ── platform guarantees ──────────────────────────────────────────────

    // Whatever it produced is archived under the run, so a later run's reset
    // cannot take the history with it.
    const runs = fs.readdirSync(path.join(ws, "runs")).filter((f) => !f.endsWith(".json"));
    assert.equal(runs.length, 1, "the run left no archive directory");
    if (wrote.length) {
      const archived = path.join(ws, "runs", runs[0], "outputs/notetaker");
      assert.deepEqual(
        fs.readdirSync(archived).sort(),
        [...wrote].sort(),
        "what the agent wrote was not archived with the run",
      );
    }

    // A memory it wrote is conformant, whether or not it knew the format.
    if (concepts.length) {
      assert.deepEqual(conformanceIssues(memory), [], "the memory bundle would fail a validator");

      for (const learned of concepts) {
        assert.ok(learned.type, `${learned.file}: type was not backfilled`);
        assert.equal(learned.generatedBy, PRODUCER, `${learned.file}: generated.by not stamped`);
        assert.deepEqual(
          provenanceMarks(learned),
          ["machine-written", "unverified"],
          `${learned.file}: a fact the agent invented does not read as one`,
        );
        // `name:` is a key OKF does not define, and models write it unprompted.
        const front = matter(fs.readFileSync(path.join(memory, learned.file), "utf8")).data;
        assert.ok(!("name" in front), `${learned.file}: \`name:\` survived stamping`);
      }

      const index = fs.readFileSync(path.join(memory, "index.md"), "utf8");
      assert.match(index, /okf_version: "0\.2"/, "the bundle root declares no version");
      assert.match(index, /machine-written/, "the index does not say who wrote it");

      const log = path.join(memory, "log.md");
      assert.ok(fs.existsSync(log), "nothing the agent learned reached log.md");
      const logged = fs.readFileSync(log, "utf8");
      for (const learned of concepts) {
        assert.match(
          logged,
          new RegExp(`\\*\\*Creation\\*\\*.*${learned.file.replace(/\.md$/, "")}`),
          `the log does not name ${learned.file}`,
        );
      }
    }

    // And the workspace it left behind still passes its own checker — a run
    // may add files, never break the thing that validates them.
    const check = foldrun("check", ws);
    assert.equal(check.status, 0, `check failed after the run:\n${check.stdout}`);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
