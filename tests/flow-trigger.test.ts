// Rewriting a flow's trigger — the dashboard's picker, and the reason
// nobody has to hand-edit frontmatter to schedule a flow any more.
//
//   node --test tests/flow-trigger.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { setFlowTrigger, parseFlow } from "../packages/core/src/store.ts";

const FLOW = `---
name: digest
# the model tier this flow prefers
model: fast
---

1. [[researcher]] — gather the week
2. [[writer]] — write it up
`;

test("scheduling a flow adds trigger, schedule and timezone — and nothing else changes", () => {
  const out = setFlowTrigger(FLOW, {
    trigger: "schedule",
    schedule: "0 8 * * MON",
    timezone: "Australia/Sydney",
  });
  const parsed = parseFlow("digest.md", out);
  assert.equal(parsed.trigger, "schedule");
  assert.equal(parsed.schedule, "0 8 * * MON");
  assert.equal(parsed.timezone, "Australia/Sydney");
  assert.match(out, /# the model tier this flow prefers/, "author comments survive");
  assert.match(out, /model: fast/);
  assert.match(out, /1\. \[\[researcher\]\] — gather the week/);
});

test("back to manual removes all three keys — manual is the default, say nothing", () => {
  const scheduled = setFlowTrigger(FLOW, { trigger: "schedule", schedule: "@daily" });
  const back = setFlowTrigger(scheduled, { trigger: "manual" });
  assert.ok(!/trigger:|schedule:|timezone:/.test(back));
  assert.equal(parseFlow("digest.md", back).trigger, "manual");
});

test("webhook needs no schedule, and clears a stale one", () => {
  const scheduled = setFlowTrigger(FLOW, { trigger: "schedule", schedule: "@hourly" });
  const hooked = setFlowTrigger(scheduled, { trigger: "webhook" });
  const parsed = parseFlow("digest.md", hooked);
  assert.equal(parsed.trigger, "webhook");
  assert.equal(parsed.schedule ?? null, null);
});

test("a bad cron is refused with the reason, not written", () => {
  assert.throws(
    () => setFlowTrigger(FLOW, { trigger: "schedule", schedule: "every tuesday" }),
    /not a cron expression/,
  );
});

test("a flow with no frontmatter gains the smallest one that carries the trigger", () => {
  const bare = "1. [[writer]] — write\n";
  const out = setFlowTrigger(bare, { trigger: "schedule", schedule: "@daily" });
  const parsed = parseFlow("bare.md", out);
  assert.equal(parsed.trigger, "schedule");
  assert.equal(parsed.schedule, "@daily");
  assert.match(out, /1\. \[\[writer\]\] — write/);
});
