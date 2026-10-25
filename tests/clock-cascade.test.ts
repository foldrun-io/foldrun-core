// The clock a step works to, resolved at every level, nearest wins.
//
// The failure this comes from: the medium desk's cron is Australia/Sydney
// and its steps ran on UTC clocks, so a run at 08:00 Sydney on the 16th
// wrote files stamped the 15th and the step after it, looking for today's
// files, found none.
//
//   node --test tests/clock-cascade.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentClock, localDate } from "../src/runner.ts";
import { normalizeZone, resolveClock, timezoneProblem } from "../src/clock.ts";
import { accountDir, parseFlow } from "../src/store.ts";
import { lintFlow } from "../src/flow-lint.ts";
import { deployIssues } from "../src/deploy.ts";

/** 22:30 UTC on the 15th — already the 16th in Sydney, still the 15th in
 *  London. Every date assertion here uses this one instant. */
const LATE = new Date("2026-09-15T22:30:00Z");

/** A workspace on disk: an account AGENTS.md, a workspace AGENTS.md, and one
 *  agent. Each `timezone:` is optional, which is the whole point. */
function workspace(zones: { account?: string; workspace?: string; agent?: string }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-clock-"));
  const prevData = process.env.FOLDRUN_DATA;
  const prevEnv = process.env.FOLDRUN_TIMEZONE;
  process.env.FOLDRUN_DATA = root;
  delete process.env.FOLDRUN_TIMEZONE;
  const tenant = "acme";
  const ws = path.join(root, tenant, "workspaces", "desk");
  const agentDir = path.join(ws, "agents", "writer");
  fs.mkdirSync(agentDir, { recursive: true });
  const front = (zone?: string, name = "desk") =>
    `---\nname: ${name}\n${zone ? `timezone: ${zone}\n` : ""}---\n\nContext.\n`;
  fs.mkdirSync(accountDir(tenant), { recursive: true });
  fs.writeFileSync(path.join(accountDir(tenant), "AGENTS.md"), front(zones.account, "acme"));
  fs.writeFileSync(path.join(ws, "AGENTS.md"), front(zones.workspace));
  fs.writeFileSync(path.join(agentDir, "agent.md"), front(zones.agent, "writer"));
  const agentFront = zones.agent ? { timezone: zones.agent } : {};
  return {
    clock: (flowTimezone?: string | null) => agentClock(agentDir, tenant, agentFront, flowTimezone),
    done() {
      if (prevData === undefined) delete process.env.FOLDRUN_DATA;
      else process.env.FOLDRUN_DATA = prevData;
      if (prevEnv !== undefined) process.env.FOLDRUN_TIMEZONE = prevEnv;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("nearest wins: agent, then flow, then workspace, then account", () => {
  const w = workspace({ account: "America/New_York", workspace: "Europe/London", agent: "Asia/Tokyo" });
  try {
    assert.deepEqual(
      { ...w.clock("Australia/Sydney") },
      { timezone: "Asia/Tokyo", tz: "Asia/Tokyo", source: "agent", problems: [] },
      "an agent's own zone beats its flow's",
    );
  } finally {
    w.done();
  }

  const noAgent = workspace({ account: "America/New_York", workspace: "Europe/London" });
  try {
    assert.equal(noAgent.clock("Australia/Sydney").timezone, "Australia/Sydney", "a flow beats the workspace");
    assert.equal(noAgent.clock("Australia/Sydney").source, "flow");
    assert.equal(noAgent.clock().timezone, "Europe/London", "the workspace beats the account");
    assert.equal(noAgent.clock().source, "workspace");
  } finally {
    noAgent.done();
  }

  const accountOnly = workspace({ account: "America/New_York" });
  try {
    assert.equal(accountOnly.clock().timezone, "America/New_York", "the account is the last written level");
    assert.equal(accountOnly.clock().source, "account");
  } finally {
    accountOnly.done();
  }
});

test("a step outside any flow still cascades agent → workspace → account", () => {
  const w = workspace({ account: "America/New_York", workspace: "Europe/London" });
  try {
    // undefined, not null: an ad-hoc agent run names no flow at all.
    assert.equal(w.clock(undefined).timezone, "Europe/London");
    assert.equal(w.clock(null).timezone, "Europe/London");
  } finally {
    w.done();
  }
});

test("nothing anywhere is UTC, and FOLDRUN_TIMEZONE sits just above it", () => {
  const w = workspace({});
  try {
    assert.equal(w.clock().timezone, "UTC");
    assert.equal(w.clock().source, "default");
    process.env.FOLDRUN_TIMEZONE = "Asia/Tokyo";
    assert.equal(w.clock().timezone, "Asia/Tokyo");
    assert.equal(w.clock().source, "FOLDRUN_TIMEZONE");
    delete process.env.FOLDRUN_TIMEZONE;
  } finally {
    w.done();
  }
});

test("an unreadable zone falls through to the next level, with one line saying so", () => {
  const w = workspace({ account: "America/New_York", workspace: "Europe/London", agent: "Sydney/Australia" });
  try {
    const clock = w.clock("Mars/Olympus_Mons");
    assert.equal(clock.timezone, "Europe/London", "two bad levels fall through to the workspace's");
    assert.equal(clock.source, "workspace");
    assert.equal(clock.problems.length, 2, "one line per value nobody can read — and nothing thrown");
    assert.match(clock.problems[0], /"Sydney\/Australia" \(agent\).*using Europe\/London \(workspace\) instead/);
    assert.match(clock.problems[1], /"Mars\/Olympus_Mons" \(flow\).*using Europe\/London \(workspace\) instead/);
  } finally {
    w.done();
  }

  const nothingLeft = workspace({ workspace: "UTC+99" });
  try {
    const clock = nothingLeft.clock();
    assert.equal(clock.timezone, "UTC", "the last resort is still the pods' own clock");
    assert.match(clock.problems[0], /"UTC\+99" \(workspace\).*using UTC instead/);
  } finally {
    nothingLeft.done();
  }
});

test("the date an agent sees is the date in its own zone", () => {
  assert.equal(localDate("UTC", LATE), "2026-09-15");
  assert.equal(localDate("Australia/Sydney", LATE), "2026-09-16", "22:30 UTC is already tomorrow in Sydney");
  assert.equal(localDate("America/Los_Angeles", LATE), "2026-09-15");
  const w = workspace({ workspace: "Australia/Sydney" });
  try {
    assert.equal(localDate(w.clock().timezone, LATE), "2026-09-16");
  } finally {
    w.done();
  }
});

test("a fixed offset is a zone too, in every shape people type it", () => {
  for (const [written, name] of [
    ["UTC+10", "+10:00"],
    ["+10:00", "+10:00"],
    ["+1000", "+10:00"],
    ["GMT+5", "+05:00"],
    ["UTC-3:30", "-03:30"],
    ["-05:30", "-05:30"],
    ["UTC", "UTC"],
    ["  utc+10 ", "+10:00"],
  ] as const) {
    assert.equal(normalizeZone(written)?.name, name, `${written} reads as ${name}`);
  }
  // TZ is what the sandbox's shell and Node read, and for a whole hour that
  // is an Etc zone — whose sign is inverted, POSIX-style.
  assert.equal(normalizeZone("UTC+10")!.tz, "Etc/GMT-10");
  assert.equal(normalizeZone("UTC-5")!.tz, "Etc/GMT+5");
  assert.equal(normalizeZone("UTC")!.tz, "UTC");
  // No Etc zone exists for a half hour, so TZ carries the POSIX spec.
  assert.equal(normalizeZone("+10:30")!.tz, "<+1030>-10:30");

  // The date, which is what the agent is actually told.
  assert.equal(localDate(normalizeZone("UTC+10")!.name, LATE), "2026-09-16", "22:30 UTC is tomorrow at +10:00");
  assert.equal(localDate(normalizeZone("+10:30")!.name, LATE), "2026-09-16", "and at +10:30");
  assert.equal(localDate(normalizeZone("-05:30")!.name, LATE), "2026-09-15");

  // And nonsense is still nonsense.
  for (const bad of ["UTC+99", "Sydney/Australia", "+15:00", "10", "", "  ", 42, null]) {
    assert.equal(normalizeZone(bad), null, `${String(bad)} is not a zone`);
  }
});

test("an offset set at any level cascades like an IANA name", () => {
  const w = workspace({ account: "UTC-5", workspace: "UTC+10" });
  try {
    assert.equal(w.clock().timezone, "+10:00");
    assert.equal(localDate(w.clock().timezone, LATE), "2026-09-16");
    assert.equal(w.clock("UTC-3:30").timezone, "-03:30", "a flow's offset beats the workspace's");
  } finally {
    w.done();
  }
});

test("resolveClock skips a level that wrote nothing without calling it a problem", () => {
  const chosen = resolveClock(
    [
      { level: "agent", value: undefined },
      { level: "flow", value: "  " },
      { level: "workspace", value: "Australia/Perth" },
    ],
    undefined,
  );
  assert.equal(chosen.timezone, "Australia/Perth");
  assert.deepEqual(chosen.problems, []);
});

test("foldrun check refuses a zone nobody can read, at flow and agent level", () => {
  const flow = (zone: string) =>
    lintFlow(parseFlow("f.md", `---\nname: f\ntimezone: ${zone}\n---\n\n1. [[a]] — do it\n`))
      .filter((w) => w.level === "error")
      .map((w) => w.message);
  assert.deepEqual(flow("Australia/Sydney"), []);
  assert.deepEqual(flow("UTC+10"), [], "an offset passes the check too");
  assert.match(flow("Sydney/Australia")[0], /^timezone: Sydney\/Australia — not a zone/);
  assert.match(flow("UTC+99")[0], /^timezone: UTC\+99 — not a zone/);

  assert.equal(timezoneProblem(undefined), null, "leaving it out is how you inherit");
  assert.equal(timezoneProblem("-05:30"), null);

  const files = (zone: string) => [
    { path: "AGENTS.md", content: `---\nname: desk\ntimezone: ${zone}\n---\n` },
    { path: "agents/writer/agent.md", content: `---\nname: writer\ntimezone: ${zone}\n---\n\nWrite.\n` },
  ];
  const zoneIssues = (zone: string) =>
    deployIssues(files(zone)).filter((i) => i.message.startsWith("timezone:"));
  assert.deepEqual(zoneIssues("Australia/Sydney"), []);
  assert.deepEqual(zoneIssues("UTC-3:30"), []);
  const bad = zoneIssues("Sydney/Australia");
  assert.deepEqual(bad.map((i) => i.where), ["AGENTS.md", "agents/writer/agent.md"]);
});
