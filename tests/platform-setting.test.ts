// The platform's `setting` hook (30 Oct 2026): where core reads an operator
// setting — the mail sender and caps, the step sizes — it asks the platform,
// which lays its operator's value over the variable. Without a platform the
// variable answers, as before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { platform, registerPlatform } from "../src/platform.ts";
import { sizeLimits } from "../src/run-container.ts";

test("without a platform the variable answers; with one, the platform's value", () => {
  const prev = platform.setting;
  const had = process.env.FOLDRUN_RUNNER_MEMORY_HEAVY;
  try {
    process.env.FOLDRUN_RUNNER_MEMORY_HEAVY = "12Gi";
    assert.equal(sizeLimits("heavy").memory, "12Gi");
    registerPlatform({ setting: (env) => (env === "FOLDRUN_RUNNER_MEMORY_HEAVY" ? "16Gi" : process.env[env]) });
    assert.equal(sizeLimits("heavy").memory, "16Gi");
    assert.equal(sizeLimits("small").memory, process.env.FOLDRUN_RUNNER_MEMORY_SMALL ?? "1Gi", "other keys pass through");
  } finally {
    registerPlatform({ setting: prev });
    if (had === undefined) delete process.env.FOLDRUN_RUNNER_MEMORY_HEAVY;
    else process.env.FOLDRUN_RUNNER_MEMORY_HEAVY = had;
  }
});
