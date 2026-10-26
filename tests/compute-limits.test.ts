// What a step's sandbox may use: its size class's figures, an agent's
// `resources:` over them, and the docker executor's CPU cap. The k8s half
// is foldrun-platform/tests/run-k8s.test.ts.
//
//   node --test tests/compute-limits.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { dockerCpus, dockerMemory, sizeLimits, resolveResources, memoryGiB } from "../src/run-container.ts";
import { readResources, resourcesProblem, quantityMi, anyMemoryMi, hasOverride, readCompute, computeProblem } from "../src/resources.ts";

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

test("sizes read as MiB with a unit, never a bare number", () => {
  assert.equal(quantityMi("512Mi"), 512);
  assert.equal(quantityMi("4Gi"), 4096);
  assert.equal(quantityMi("1.5Gi"), 1536);
  assert.equal(quantityMi("2g"), 2048, "docker's spelling");
  assert.ok(Number.isNaN(quantityMi("4")), "4 of what?");
  assert.ok(Number.isNaN(quantityMi(4)));
  assert.ok(Number.isNaN(quantityMi("lots")));
  assert.ok(Number.isNaN(quantityMi("4G")), "decimal to k8s, binary to docker: refused");
  assert.match(resourcesProblem({ memory: "4G" }) ?? "", /write 4Gi or 512Mi \(Gi and Mi/);
});

test("resources: in bounds and in steps is applied, normalised", () => {
  const { value, problems } = readResources({ cpu: 2.5, memory: "1.5Gi", disk: "10Gi" });
  assert.deepEqual(problems, []);
  assert.deepEqual(value, { cpu: 2.5, memory: "1536Mi", disk: "10Gi" });
  assert.deepEqual(readResources(undefined), { value: {}, problems: [] });
  assert.equal(hasOverride({}), false);
  assert.equal(hasOverride({ cpu: 1 }), true);
});

test("resources: out of bounds, off the step or misspelt is dropped and said, key by key", () => {
  const { value, problems } = readResources({ cpu: 12, memory: "300Mi", disk: "2.5Gi", gpu: 1 });
  assert.deepEqual(value, {}, "nothing guessed at");
  assert.equal(problems.length, 4);
  assert.match(problems.join(" | "), /gpu.*not one of cpu, memory, disk/);
  assert.match(problems.join(" | "), /cpu: 12 is not 0.5 to 8 cores in halves/);
  assert.match(problems.join(" | "), /memory: 300Mi is not 256Mi to 16Gi in steps of 256Mi/);
  assert.match(problems.join(" | "), /disk: 2.5Gi is not a whole 1Gi to 40Gi/);
  // One bad key never takes the good ones with it.
  assert.deepEqual(readResources({ cpu: 0.25, memory: "2Gi" }).value, { memory: "2048Mi" });
  assert.match(resourcesProblem({ cpu: true }) ?? "", /not a number of cores/);
  assert.match(resourcesProblem([1]) ?? "", /not a map/);
  assert.equal(resourcesProblem({ cpu: 8, memory: "16Gi", disk: "40Gi" }), null, "the bounds themselves are allowed");
});

test("an override replaces the class's figure key by key; the rest stay the class's", () => {
  const prev = { c: process.env.FOLDRUN_RUNNER_CPUS, m: process.env.FOLDRUN_RUNNER_MEMORY };
  process.env.FOLDRUN_RUNNER_CPUS = "3";
  process.env.FOLDRUN_RUNNER_MEMORY = "6Gi";
  try {
    assert.deepEqual(resolveResources("large"), { cpus: "3", memory: "6Gi", disk: null });
    assert.deepEqual(resolveResources("large", { memory: "1024Mi" }), { cpus: "3", memory: "1024Mi", disk: null });
    assert.deepEqual(resolveResources("large", { cpu: 1, disk: "30Gi" }), { cpus: "1", memory: "6Gi", disk: "30Gi" });
    // After an OOM moved the step to heavy, a smaller override never holds it below heavy.
    assert.deepEqual(resolveResources("heavy", { cpu: 1, memory: "3072Mi" }, { atLeastClass: true }), { cpus: "4", memory: "8Gi", disk: null });
    // Disk too: an agent's 2Gi evicted for disk retries at heavy's 20Gi,
    // while a disk bigger than heavy's is kept.
    assert.equal(resolveResources("heavy", { disk: "2Gi" }, { atLeastClass: true }).disk, null, "null is the class's");
    assert.equal(resolveResources("heavy", { disk: "30Gi" }, { atLeastClass: true }).disk, "30Gi");
    assert.equal(resolveResources("large", { disk: "2Gi" }).disk, "2Gi", "first attempt: the agent's own");
    // A bigger override still wins after the move.
    assert.deepEqual(resolveResources("heavy", { cpu: 6, memory: "12288Mi" }, { atLeastClass: true }), { cpus: "6", memory: "12288Mi", disk: null });
  } finally {
    for (const [k, v] of [["FOLDRUN_RUNNER_CPUS", prev.c], ["FOLDRUN_RUNNER_MEMORY", prev.m]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("the reservation record reads every memory spelling the same", () => {
  assert.equal(memoryGiB("6Gi"), 6);
  assert.equal(memoryGiB("2g"), 2);
  assert.equal(memoryGiB("1536Mi"), 1.5);
});

test("memory reaches docker in a spelling docker accepts (it refuses Mi and Gi)", () => {
  assert.equal(dockerMemory("1Gi"), "1073741824", "small's default");
  assert.equal(dockerMemory("8Gi"), "8589934592", "heavy's default");
  assert.equal(dockerMemory("1536Mi"), "1610612736", "a resources: figure");
  assert.equal(dockerMemory("2g"), "2g", "docker's own passes through");
  assert.equal(dockerMemory("512m"), "512m");
  assert.equal(dockerMemory("1G"), "1000000000", "decimal is decimal");
  assert.equal(dockerMemory("lots"), "lots", "docker's own error names it");
});

test("a value shaped to break the parser is a finding, never a crash or a coercion", () => {
  const evil = { toString() { throw new Error("nope"); } };
  assert.doesNotThrow(() => readResources({ cpu: evil, memory: evil, disk: evil }));
  assert.deepEqual(readResources({ cpu: evil }).value, {});
  assert.deepEqual(readResources({ cpu: [2] }).value, {}, "a list is not 2 cores");
  assert.deepEqual(readResources({ cpu: "1.5" }).value, { cpu: 1.5 }, "a string of a number is one");
});

test("a class's memory in any spelling an install uses still floors a retry", () => {
  assert.equal(anyMemoryMi("8589934592"), 8192, "bytes");
  assert.equal(anyMemoryMi("2g"), 2048);
  assert.equal(anyMemoryMi("6Gi"), 6144);
  assert.equal(anyMemoryMi("1G"), 1e9 / 2 ** 20);
  const prev = process.env.FOLDRUN_RUNNER_MEMORY_HEAVY;
  process.env.FOLDRUN_RUNNER_MEMORY_HEAVY = "8589934592";
  try {
    assert.equal(resolveResources("heavy", { memory: "3072Mi" }, { atLeastClass: true }).memory, "8589934592");
    assert.equal(memoryGiB("8589934592"), 8);
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_RUNNER_MEMORY_HEAVY;
    else process.env.FOLDRUN_RUNNER_MEMORY_HEAVY = prev;
  }
});

test("an account's compute: is read as cores and GiB; anything else is said", () => {
  assert.deepEqual(readCompute({ vcpu: 4, memory: "8Gi" }), { value: { vcpu: 4, memGiB: 8 }, problems: [] });
  assert.deepEqual(readCompute({ memory: "1536Mi" }).value, { memGiB: 1.5 });
  assert.equal(computeProblem(undefined), null);
  assert.match(computeProblem({ vcpu: 0.2 }) ?? "", /0.5 or more in halves/);
  assert.match(computeProblem({ memory: 8 }) ?? "", /write 8Gi/);
  assert.match(computeProblem({ gpus: 1 }) ?? "", /not vcpu or memory/);
  assert.match(computeProblem("lots") ?? "", /not a map/);
});
