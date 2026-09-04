// A scope's defaults, read from frontmatter and checked on the way in.

import test from "node:test";
import assert from "node:assert/strict";
import { defaultsOf, defaultsPatch } from "../web/components/defaults-model.ts";

test("defaults read out of frontmatter, with the notify events defaulted", () => {
  assert.deepEqual(defaultsOf({ timezone: "Australia/Sydney", budget: "40", notify: { email: "x@y.z" } }), {
    timezone: "Australia/Sydney",
    budget: 40,
    notify: { email: "x@y.z", events: ["failed", "awaiting-approval"] },
  });
  assert.deepEqual(defaultsOf({}), { timezone: null, budget: null, notify: null });
});

test("a patch touches only the keys sent, and refuses bad values whole", () => {
  assert.deepEqual(defaultsPatch({ budget: "12.5" }), { keys: { budget: 12.5 } });
  assert.deepEqual(defaultsPatch({ budget: "" }), { keys: { budget: null } });
  assert.ok("error" in defaultsPatch({ budget: "abc" }));
  assert.ok("error" in defaultsPatch({ timezone: "Mars/Olympus" }));
  assert.deepEqual(defaultsPatch({ timezone: "UTC" }), { keys: { timezone: "UTC" } });
  assert.ok("error" in defaultsPatch({}));
});

test("notify needs a destination and an event, and keeps a secret-named URL", () => {
  assert.ok("error" in defaultsPatch({ notify: { events: ["failed"] } }));
  assert.ok("error" in defaultsPatch({ notify: { email: "nope", events: ["failed"] } }));
  assert.ok("error" in defaultsPatch({ notify: { url: "ftp://x", events: ["failed"] } }));
  assert.ok("error" in defaultsPatch({ notify: { email: "a@b.co", events: [] } }));
  assert.deepEqual(defaultsPatch({ notify: { url: "${SLACK_WEBHOOK_URL}", email: "", events: ["failed", "bogus", "completed"] } }), {
    keys: { notify: { url: "${SLACK_WEBHOOK_URL}", events: ["failed", "completed"] } },
  });
  assert.deepEqual(defaultsPatch({ notify: null }), { keys: { notify: null } });
});
