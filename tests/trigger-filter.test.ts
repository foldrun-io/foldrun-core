// `filter:` — which deliveries of an event trigger become runs.
//
//   node --test tests/trigger-filter.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { checkFilter, matchFilter, webhookFilterPayload } from "../src/trigger-filter.ts";
import { parseFlow } from "../src/store.ts";
import { lintFlow } from "../src/flow-lint.ts";
import { platform } from "../src/platform.ts";

const pr = {
  action: "opened",
  number: 42,
  pull_request: { draft: false, base: { ref: "main" }, labels: [{ name: "bug" }, { name: "ui" }] },
  sender: { login: "ana", type: "User" },
  tags: ["a", "b"],
};

test("a list is the values allowed, a scalar the one value, nested maps nest", () => {
  assert.equal(matchFilter({ action: ["opened", "reopened"] }, pr).match, true);
  assert.equal(matchFilter({ action: "opened" }, pr).match, true);
  assert.equal(matchFilter({ pull_request: { draft: false } }, pr).match, true);
  assert.equal(matchFilter({ pull_request: { base: { ref: "main" } } }, pr).match, true);
  const v = matchFilter({ action: ["closed"] }, pr);
  assert.equal(v.match, false);
  assert.match(v.reason, /action is "opened", not "closed"/);
});

test("every key must match", () => {
  assert.equal(matchFilter({ action: "opened", sender: { type: "Bot" } }, pr).match, false);
  assert.equal(matchFilter({ action: "opened", sender: { type: "User" } }, pr).match, true);
});

test("operators: in, not_in, exists, starts_with, ends_with, contains", () => {
  assert.equal(matchFilter({ sender: { type: { not_in: ["Bot"] } } }, pr).match, true);
  assert.equal(matchFilter({ sender: { type: { not_in: ["User"] } } }, pr).match, false);
  assert.equal(matchFilter({ sender: { type: { in: ["User", "Bot"] } } }, pr).match, true);
  assert.equal(matchFilter({ pull_request: { merged_at: { exists: false } } }, pr).match, true);
  assert.equal(matchFilter({ pull_request: { draft: { exists: true } } }, pr).match, true);
  assert.equal(matchFilter({ pull_request: { merged_at: { exists: true } } }, pr).match, false);
  assert.equal(matchFilter({ sender: { login: { starts_with: "an" } } }, pr).match, true);
  assert.equal(matchFilter({ sender: { login: { starts_with: "bo" } } }, pr).match, false);
  assert.equal(matchFilter({ sender: { login: { ends_with: "na" } } }, pr).match, true);
  assert.equal(matchFilter({ sender: { login: { contains: "n" } } }, pr).match, true);
  assert.equal(matchFilter({ sender: { login: { contains: "N" } } }, pr).match, false, "case-sensitive");
  assert.equal(matchFilter({ number: { starts_with: "4" } }, pr).match, true, "a number is read as its digits");
  assert.match(matchFilter({ sender: { login: { starts_with: "bo" } } }, pr).reason, /does not start with "bo"/);
  assert.match(matchFilter({ sender: { login: { contains: "z" } } }, pr).reason, /does not contain "z"/);
});

test("a missing field fails in, a value and the text operators, and passes not_in", () => {
  assert.equal(matchFilter({ env: ["prod"] }, pr).match, false);
  assert.equal(matchFilter({ env: { in: ["prod"] } }, pr).match, false);
  assert.equal(matchFilter({ env: { contains: "" } }, pr).match, false);
  assert.equal(matchFilter({ env: { contains: "p" } }, pr).match, false);
  assert.equal(matchFilter({ env: { not_in: ["dev"] } }, pr).match, true);
  assert.match(matchFilter({ env: ["prod"] }, pr).reason, /env is missing/);
  // A nested pattern requires its key.
  assert.equal(matchFilter({ deployment: { env: { not_in: ["dev"] } } }, pr).match, false);
});

test("lists in the payload: any element of objects; overlap for in, none for not_in", () => {
  assert.equal(matchFilter({ pull_request: { labels: { name: "bug" } } }, pr).match, true);
  assert.equal(matchFilter({ pull_request: { labels: { name: "docs" } } }, pr).match, false);
  assert.equal(matchFilter({ tags: { in: ["b", "z"] } }, pr).match, true);
  assert.equal(matchFilter({ tags: { not_in: ["z"] } }, pr).match, true);
  assert.equal(matchFilter({ tags: { not_in: ["a"] } }, pr).match, false);
  assert.equal(matchFilter({ tags: "a" }, pr).match, true);
});

test("types: exact case-sensitive strings, numbers numerically, booleans and null as themselves", () => {
  assert.equal(matchFilter({ action: "Opened" }, pr).match, false);
  assert.equal(matchFilter({ number: 42.0 }, pr).match, true);
  assert.equal(matchFilter({ number: "42" }, pr).match, false, "the text 42 is not the number 42");
  assert.equal(matchFilter({ pull_request: { draft: "false" } }, pr).match, false);
  assert.equal(matchFilter({ x: null }, { x: null }).match, true);
});

test("it fails closed: a body that is not JSON, a filter that cannot be read", () => {
  assert.equal(matchFilter({ action: "opened" }, webhookFilterPayload("action=opened")).match, false);
  assert.equal(matchFilter({ action: "opened" }, webhookFilterPayload(JSON.stringify(pr))).match, true);
  assert.equal(matchFilter({ action: { in: ["a"], not_in: ["a"] } }, { action: "b" }).match, false);
  assert.equal(matchFilter({ action: { contains: 3 } }, { action: "3" }).match, false, "an operator that cannot be read fails closed");
  assert.equal(matchFilter("opened", pr).match, false);
  assert.equal(matchFilter(null, "anything").match, true, "no filter passes everything");
});

test("checkFilter names what cannot be read", () => {
  assert.deepEqual(checkFilter({ action: ["opened"] }), []);
  assert.deepEqual(checkFilter(undefined), []);
  const said = (f: unknown) => checkFilter(f).join(" | ");
  assert.match(said("opened"), /map of field names/);
  assert.match(said({}), /map of field names/);
  assert.match(said({ a: { in: ["x"], not_in: ["x"] } }), /in both in and not_in/);
  assert.match(said({ a: { exists: false, in: ["x"] } }), /exists: false cannot also require a value/);
  assert.match(said({ a: { exists: "yes" } }), /exists: is true or false/);
  assert.match(said({ a: { contains: 3 } }), /contains: is text/);
  assert.match(said({ a: { starts_with: "" } }), /starts_with: is text/);
  assert.match(said({ a: { ends_with: "x".repeat(501) } }), /longer than 500/);
  assert.match(said({ a: { exists: false, contains: "x" } }), /exists: false cannot also require a value/);
  assert.deepEqual(checkFilter({ a: { matches: "x" } }), [], "matches: is a field name like any other, not an operator");
  assert.match(said({ a: { in: ["x"], login: "y" } }), /mixes operators/);
  assert.match(said({ in: ["x"] }), /is an operator/);
  assert.match(said({ a: [] }), /empty/);
  assert.match(said({ a: [{ b: 1 }] }), /only plain values/);
  assert.match(said({ a: {} }), /empty map/);
  let deep: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < 11; i++) deep = { n: deep };
  assert.match(said(deep), /deeper than 10/);
  const wide: Record<string, unknown> = {};
  for (let i = 0; i < 70; i++) wide[`k${i}`] = i;
  assert.match(said(wide), /at most 64/);
  assert.match(said({ a: Array.from({ length: 40 }, (_, i) => i) }), /at most 32/);
});

test("YAML dates in a filter are read as the date text", () => {
  assert.equal(matchFilter({ day: new Date("2026-10-01T00:00:00Z") }, { day: "2026-10-01" }).match, true);
});

const flowText = (front: string) => `---\ntrigger: webhook\n${front}\n---\n\n1. [[writer]] — Write it.\n`;

test("parseFlow reads filter: and refuses one it cannot read", () => {
  const ok = parseFlow("f.md", flowText("filter:\n  action: [opened]\n  sender:\n    type: { not_in: [Bot] }"));
  assert.deepEqual(ok.filter, { action: ["opened"], sender: { type: { not_in: ["Bot"] } } });
  assert.deepEqual(ok.frontProblems, []);
  const bad = parseFlow("f.md", flowText("filter:\n  action: { in: [a], not_in: [a] }"));
  assert.ok(bad.frontProblems?.some((p) => /in both in and not_in/.test(p)), String(bad.frontProblems));
  assert.equal(parseFlow("f.md", flowText("")).filter, null);
});

test("the lint warns when the trigger has no payload to filter", () => {
  const flow = parseFlow("f.md", "---\ntrigger: schedule\nschedule: \"0 9 * * 1\"\nfilter:\n  a: b\n---\n\n1. [[writer]] — Write it.\n");
  assert.ok(lintFlow(flow).some((w) => /filter: only applies/.test(w.message)));
  const hook = parseFlow("f.md", flowText("filter:\n  a: b"));
  assert.ok(!lintFlow(hook).some((w) => /filter: only applies/.test(w.message)));
});

test("the laptop's gate applies the filter too, and only when given fields", async () => {
  const flow = parseFlow("f.md", flowText("filter:\n  action: [opened]"));
  assert.deepEqual(await platform.admitTrigger("t", "w", flow, { fields: { action: "opened" } }), { admit: true });
  const no = await platform.admitTrigger("t", "w", flow, { fields: { action: "closed" } });
  assert.equal(no.admit, false);
  assert.equal(!no.admit && no.reason, "filtered");
  assert.deepEqual(await platform.admitTrigger("t", "w", flow, {}), { admit: true }, "a schedule passes no fields");
});

test("a filter that cannot be read is kept, so the gate fails closed instead of admitting everything", async () => {
  for (const front of ["filter: [opened]", "filter: false", "filter: opened"]) {
    const flow = parseFlow("f.md", flowText(front));
    assert.notEqual(flow.filter, null, front);
    assert.ok(flow.frontProblems?.length, `${front} is a check error`);
    const v = await platform.admitTrigger("t", "w", flow, { fields: { action: "opened" } });
    assert.equal(v.admit, false, `${front} admits nothing`);
  }
});

test("a nested pattern over a scalar or null does not match, even for not_in or exists: false", () => {
  assert.equal(matchFilter({ sender: { type: { not_in: ["Bot"] } } }, { sender: null }).match, false);
  assert.equal(matchFilter({ sender: { type: { exists: false } } }, { sender: "x" }).match, false);
  assert.match(matchFilter({ sender: { type: "User" } }, { sender: 3 }).reason, /not an object/);
});
