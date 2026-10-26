// What a step's sandbox may use: its size class's figures, and the docker
// executor's CPU cap. The k8s half is foldrun-platform/tests/run-k8s.test.ts.
//
//   node --test tests/compute-limits.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { dockerCpus, sizeLimits } from "../src/run-container.ts";

test("the docker CPU cap is the class's billed cores, no more than the engine has", () => {
  assert.equal(dockerCpus("2", 8), "2");
  assert.equal(dockerCpus("4", 2), "2", "a heavy step on a two-core server still starts");
  assert.equal(dockerCpus("0.5", 8), "0.5");
  assert.equal(dockerCpus("lots", 8), null, "a typo leaves the flag off instead of failing the step");
  assert.equal(dockerCpus("0", 8), null);
});

test("each class carries a cores figure the cap reads", () => {
  for (const size of ["small", "large", "heavy"] as const) {
    assert.ok(Number(sizeLimits(size).cpus) > 0, size);
  }
});
