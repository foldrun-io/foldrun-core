// A script's arguments reach it as command-line text, and the model is told
// so — but a model sends 10 for "how many results", and the call must not
// die at the schema for it.

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { scriptArgShape } from "../src/script-tools.ts";

test("a number or a boolean for a script argument is accepted, not refused", () => {
  const schema = z.object(scriptArgShape({ query: "the term", depth: "how many results", dry: "true to only print" }));
  assert.deepEqual(schema.parse({ query: "x", depth: 10, dry: true }), { query: "x", depth: 10, dry: true });
  assert.deepEqual(schema.parse({ query: "x", depth: "10" }), { query: "x", depth: "10" });
  assert.deepEqual(schema.parse({}), {});
  assert.throws(() => schema.parse({ depth: { n: 10 } }), "an object is still refused");
});
