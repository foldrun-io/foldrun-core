// The frontmatter that says how many of a trigger's starts are real, and the
// rules about who may answer a gate.
//
//   node --test tests/trigger-gates.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlow, mayApprove } from "../src/store.ts";
import { deliveryKey } from "../src/triggers.ts";
import { lintFlow } from "../src/flow-lint.ts";

const flowWith = (frontmatter: string) =>
  parseFlow(
    "orders.md",
    `---\nname: orders\ntrigger: webhook\n${frontmatter}\n---\n\n1! [[reviewer]] — check it\n`,
  );

// ------------------------------------------------------------- parsing

test("the gates parse as literals, in the same duration units as wait:", () => {
  const flow = flowWith(
    [
      "idempotency: X-GitHub-Delivery",
      "throttle: 15m",
      "debounce: 90s",
      "catchup: none",
      "disable_after: 5",
      "sla: 2h",
      "approve_within: 3d",
      "approvers: [Ops@Example.com, admins]",
    ].join("\n"),
  );
  // Lower-cased: a header name is case-insensitive on the wire, and an
  // address that differs only in case is the same person.
  assert.equal(flow.idempotency, "x-github-delivery");
  assert.equal(flow.throttle, 15 * 60);
  assert.equal(flow.debounce, 90);
  assert.equal(flow.catchup, "none");
  assert.equal(flow.disableAfter, 5);
  assert.equal(flow.sla, 2 * 3600);
  assert.equal(flow.approveWithin, 3 * 86400);
  assert.deepEqual(flow.approvers, ["ops@example.com", "admins"]);
});

test("a flow that says none of it gets null for all of it — nothing is on by default", () => {
  const flow = flowWith("description: plain");
  assert.equal(flow.idempotency, null);
  assert.equal(flow.throttle, null);
  assert.equal(flow.debounce, null);
  assert.equal(flow.catchup, null);
  assert.equal(flow.disableAfter, null);
  assert.equal(flow.sla, null);
  assert.equal(flow.approvers, null);
  assert.equal(flow.approveWithin, null);
});

test("nonsense values are refused rather than half-read", () => {
  const flow = flowWith(
    ["throttle: soon", "debounce: -5", "catchup: maybe", "disable_after: 0", "approvers: []"].join("\n"),
  );
  assert.equal(flow.throttle, null, "an unparseable duration is no throttle, not a zero one");
  assert.equal(flow.debounce, null);
  assert.equal(flow.catchup, null);
  assert.equal(flow.disableAfter, null, "zero failures would quarantine a flow that never ran");
  assert.equal(flow.approvers, null, "an empty list is no list — it must not lock everyone out");
});

test("a single address is a list, and duplicates collapse", () => {
  assert.deepEqual(flowWith("approvers: ops@example.com").approvers, ["ops@example.com"]);
  assert.deepEqual(flowWith("approvers: [a@x.com, A@X.com]").approvers, ["a@x.com"]);
});

test("durations are capped at thirty days, like every other duration in the format", () => {
  assert.equal(flowWith("throttle: 400d").throttle, 30 * 86400);
});

// ------------------------------------------------------- delivery keys

test("idempotency reads a header, or a top-level field of a JSON body", () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;

  assert.equal(deliveryKey("x-delivery", headers({ "x-delivery": "abc" }), ""), "abc");
  assert.equal(deliveryKey("body:message_id", () => null, JSON.stringify({ message_id: "m-1" })), "m-1");
  // A number is an identifier too; it comes back as text because that is
  // what it is compared as.
  assert.equal(deliveryKey("body:id", () => null, JSON.stringify({ id: 42 })), "42");
});

test("a delivery that carries no key is admitted, never refused", () => {
  // Refusing a delivery because the sender omitted a header would turn
  // "dedupe when you can" into an outage.
  assert.equal(deliveryKey("x-delivery", () => null, ""), null);
  assert.equal(deliveryKey("body:id", () => null, "not json at all"), null);
  assert.equal(deliveryKey("body:id", () => null, JSON.stringify({ other: 1 })), null);
  assert.equal(deliveryKey(null, () => "anything", "{}"), null, "no idempotency: means no key");
});

test("a key is bounded — a sender does not get to write a megabyte into our state", () => {
  const long = "x".repeat(5000);
  assert.equal(deliveryKey("x-delivery", () => long, "")!.length, 200);
});

// ------------------------------------------------------ who may approve

test("no approvers: means the existing rule — whoever could reach the route", () => {
  assert.equal(mayApprove(flowWith("description: plain"), { email: "anyone@x.com", role: "editor" }), true);
});

test("approvers: is an allowlist, and admins is a role rather than an address", () => {
  const flow = flowWith("approvers: [ops@example.com, admins]");
  assert.equal(mayApprove(flow, { email: "ops@example.com", role: "viewer" }), true);
  assert.equal(mayApprove(flow, { email: "OPS@EXAMPLE.COM", role: "viewer" }), true, "case-insensitive");
  assert.equal(mayApprove(flow, { email: "someone@else.com", role: "admin" }), true, "admins");
  assert.equal(mayApprove(flow, { email: "someone@else.com", role: "owner" }), true, "owner is above admin");
  assert.equal(mayApprove(flow, { email: "someone@else.com", role: "editor" }), false);
});

test("a named list without admins does not let an admin through", () => {
  const flow = flowWith("approvers: ops@example.com");
  assert.equal(mayApprove(flow, { email: "boss@example.com", role: "owner" }), false);
});

// --------------------------------------------------------------- lint

test("check names a gate rule that can never apply", () => {
  const noGate = parseFlow(
    "x.md",
    "---\nname: x\napprovers: ops@example.com\napprove_within: 1d\n---\n\n1. [[writer]] — write\n",
  );
  const messages = lintFlow(noGate).map((w) => w.message);
  assert.ok(messages.some((m) => m.includes("approvers:")), "an approvers list with no gate is inert");
  assert.ok(messages.some((m) => m.includes("approve_within:")), "so is a deadline with no gate");
});

test("check names an idempotency key with no delivery to read, and a catchup with nothing to miss", () => {
  const scheduled = parseFlow(
    "x.md",
    '---\nname: x\ntrigger: schedule\nschedule: "0 5 * * *"\nidempotency: x-id\n---\n\n1. [[writer]] — write\n',
  );
  assert.ok(lintFlow(scheduled).some((w) => w.message.includes("idempotency:")));

  const manual = parseFlow("x.md", "---\nname: x\ncatchup: none\n---\n\n1. [[writer]] — write\n");
  assert.ok(lintFlow(manual).some((w) => w.message.includes("catchup:")));
});

test("a gate with its rules attached lints clean", () => {
  const good = parseFlow(
    "x.md",
    "---\nname: x\napprovers: ops@example.com\napprove_within: 1d\n---\n\n1! [[writer]] — write\n",
  );
  const messages = lintFlow(good).map((w) => w.message);
  assert.ok(!messages.some((m) => m.includes("approvers:") || m.includes("approve_within:")));
});
