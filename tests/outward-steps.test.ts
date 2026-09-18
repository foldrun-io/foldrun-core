// A step that can act on the outside world, with nothing to say whether it
// did. `check` refuses it: the two acceptable answers are a verify the
// runtime can fail on, or a person.
import test from "node:test";
import assert from "node:assert/strict";
import { lintFlow } from "../src/flow-lint.ts";
import { toolIsOutward } from "../src/store.ts";

const flow = (step: Record<string, unknown>) => ({
  name: "f", file: "f.md", steps: [{ group: 1, agent: "sender", line: 3, ...step }],
}) as never;
const known = { agents: ["sender"], outwardAgents: ["sender"] };
const outwardErrors = (f: never, k = known) =>
  lintFlow(f, k).filter((w) => w.message.includes("act outside this workspace"));

test("no verify and no gate on an outward step is an error, not a warning", () => {
  const [w] = outwardErrors(flow({}));
  assert.ok(w, "the rule fired");
  assert.equal(w.level, "error");
  assert.match(w.message, /\[\[sender\]\] can act outside this workspace/);
  assert.match(w.detail, /sends, posts, buys or publishes/);
  assert.equal(w.line, 3, "it points at the step");
});

test("a verify satisfies it, and so does a person", () => {
  assert.equal(outwardErrors(flow({ verify: "test -s ../../storage/sent.md" })).length, 0);
  assert.equal(outwardErrors(flow({ approve: true })).length, 0);
  assert.equal(outwardErrors(flow({ ask: "Send these?" })).length, 0);
});

test("an agent that cannot act outward is not asked to prove anything", () => {
  assert.equal(outwardErrors(flow({}), { agents: ["sender"], outwardAgents: [] }).length, 0);
});

test("a caller that did not resolve the grants skips the rule rather than guessing", () => {
  assert.equal(outwardErrors(flow({}), { agents: ["sender"] }).length, 0);
});

test("outward is opt-in and explicit: only `outward: true` counts", () => {
  assert.equal(toolIsOutward({ outward: true }), true);
  assert.equal(toolIsOutward({ outward: "yes" }), false);
  assert.equal(toolIsOutward({}), false);
});
