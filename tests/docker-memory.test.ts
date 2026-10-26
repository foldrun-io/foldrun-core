// The docker executor's --memory: Docker 29 refuses Kubernetes' Mi and Gi,
// which the small and heavy defaults are written in.
//
//   node --test tests/docker-memory.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { dockerMemory, sizeLimits } from "../src/run-container.ts";

test("memory reaches docker in a spelling docker accepts (it refuses Mi and Gi)", () => {
  assert.equal(dockerMemory("1Gi"), "1073741824", "small's default");
  assert.equal(dockerMemory("8Gi"), "8589934592", "heavy's default");
  assert.equal(dockerMemory("1536Mi"), "1610612736");
  assert.equal(dockerMemory("2g"), "2g", "docker's own passes through: large's default");
  assert.equal(dockerMemory("512m"), "512m");
  assert.equal(dockerMemory("1G"), "1000000000", "decimal is decimal");
  assert.equal(dockerMemory("lots"), "lots", "docker's own error names it");
});

test("every class's default reaches docker without a k8s suffix", () => {
  for (const size of ["small", "large", "heavy"] as const) {
    assert.doesNotMatch(dockerMemory(sizeLimits(size).memory), /[KMGT]i$/, size);
  }
});
