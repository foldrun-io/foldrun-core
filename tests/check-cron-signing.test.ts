// Two check rules of 30 Oct 2026, both warnings:
//  - config/cron-never-fires: a schedule whose every field is in range but
//    whose day no month has (`0 0 30 2 *`). check reads it with the same
//    cronCanFire the scheduler does, so the two agree that it never fires.
//  - secret/signing-secret-value: a flow's `signing_secret:` or notify's
//    `signing_secret:` holding something that is not a vault secret's name —
//    a value written into a deployed, versioned file. The finding, and every
//    answer that shows the setting (signingSecretShown), never repeat it.
//
//   node --test tests/check-cron-signing.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { scanFiles, scanRule, ruleDocsUrl } from "../src/scan.ts";
import { signingSecretProblem } from "../src/frontmatter-schema.ts";
import { signingSecretShown } from "../src/secrets.ts";

const flow = (front: string) => ({ path: "flows/f.md", content: `---\n${front}\n---\n\n1. [[a]] — go\n` });
const rules = (files: { path: string; content: string }[], rule: string) => scanFiles(files).filter((f) => f.rule === rule);

test("config/cron-never-fires: the 30th of February warns; a reachable day does not", () => {
  const never = rules([flow('trigger: schedule\nschedule: "0 0 30 2 *"')], "config/cron-never-fires");
  assert.equal(never.length, 1);
  assert.equal(never[0]!.level, "warn");
  assert.equal(never[0]!.line, 3, "on the schedule: line");
  assert.match(never[0]!.message, /never fires/);
  for (const ok of ['"0 0 29 2 *"', '"0 9 * * 1"', '"0 0 30 2 mon"', "'@daily'"]) {
    assert.deepEqual(rules([flow(`trigger: schedule\nschedule: ${ok}`)], "config/cron-never-fires"), [], ok);
  }
  // A cron the scheduler cannot read at all is config/invalid-value, not this.
  assert.deepEqual(rules([flow('schedule: "0 0 32 2 *"')], "config/cron-never-fires"), []);
});

test("secret/signing-secret-value: a flow's literal signing_secret warns without repeating it", () => {
  const literal = "whsec_" + "notaname0123";
  const found = rules([flow(`trigger: webhook\nsignature: hmac\nsigning_secret: ${literal}`)], "secret/signing-secret-value");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.level, "warn");
  assert.equal(found[0]!.line, 4, "on the signing_secret: line");
  assert.ok(!found[0]!.message.includes(literal), "the message never holds the value");
  for (const name of ["HOOK_KEY", "${HOOK_KEY}", " ${GITHUB_WEBHOOK_SECRET} "]) {
    assert.deepEqual(rules([flow(`trigger: webhook\nsignature: github\nsigning_secret: "${name}"`)], "secret/signing-secret-value"), [], name);
  }
});

test("secret/signing-secret-value: notify's signing_secret, at the top or under observability:", () => {
  const literal = "s3cr3t-" + "value";
  const top = rules([{ path: "AGENTS.md", content: `---\nnotify:\n  url: https://hooks.example.com/x\n  signing_secret: ${literal}\n---\n` }], "secret/signing-secret-value");
  assert.equal(top.length, 1);
  assert.equal(top[0]!.line, 2, "on the notify: line");
  assert.ok(!top[0]!.message.includes(literal));
  const block = rules([{ path: "AGENTS.md", content: `---\nobservability:\n  notify:\n    url: https://hooks.example.com/x\n    signing_secret: ${literal}\n---\n` }], "secret/signing-secret-value");
  assert.equal(block.length, 1);
  assert.deepEqual(rules([{ path: "AGENTS.md", content: "---\nnotify:\n  url: https://hooks.example.com/x\n  signing_secret: OPS_WEBHOOK_SIGNING_KEY\n---\n" }], "secret/signing-secret-value"), []);
  assert.deepEqual(rules([{ path: "AGENTS.md", content: "---\nnotify: ops@example.com\n---\n" }], "secret/signing-secret-value"), []);
});

test("both rules are known rules with a docs anchor, and --security / only: secret reaches the signing one", () => {
  for (const id of ["config/cron-never-fires", "secret/signing-secret-value"]) {
    assert.equal(scanRule(id)?.level, "warn", id);
    assert.ok(ruleDocsUrl(id).endsWith(`#${id.replace("/", "-")}`));
  }
  const only = scanFiles([flow("signing_secret: lower-case-value")], { only: ["secret"] }).map((f) => f.rule);
  assert.ok(only.includes("secret/signing-secret-value"), only.join());
});

test("signingSecretProblem and signingSecretShown: a name passes and is shown; anything else is described, never shown", () => {
  assert.equal(signingSecretProblem("HOOK_KEY"), null);
  assert.equal(signingSecretProblem("${HOOK_KEY}"), null);
  assert.equal(signingSecretProblem(7), null, "a non-string is config/wrong-type's to report");
  assert.ok(signingSecretProblem("hunter2"));
  assert.equal(signingSecretShown("HOOK_KEY"), "HOOK_KEY");
  const shown = signingSecretShown("hunter2-literal");
  assert.ok(!shown.includes("hunter2"), shown);
});
