// Slim browsing through the account's browser pod, with a safe fallback
// (browser-pod.ts). The pure parts — what a call counts as, the decision,
// the pod log — then the model loop with the pod dying mid-step, then the
// runner: a reads-only step re-run on the full image, a step that wrote
// failed and not re-run, and an outward step's input marked so the
// executor keeps it on full.
//
//   node --test tests/browser-pod.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSE_WRITE_ACTIONS, RERAN_ON_FULL, browseActionNames, browserPodLine, classifyCall, describeWrites,
  paidWebActions, parseBrowserPod, podAt, podLossDecision, podTriesLine, readPodEvents, slimBrowseBlocker,
} from "../src/browser-pod.ts";
import { WEB_BROWSE_ACTIONS } from "../src/providers.ts";
import { executeStep, type QueryFn } from "../src/step-exec.ts";
import { parseDriverLine, type RunInContainerArgs, type ContainerStepOutcome } from "../src/run-container.ts";
import { startFlowRun, waitForRun, recordAttempt } from "../src/runner.ts";
import { registerPlatform, platform } from "../src/platform.ts";
import type { FlowStep, StepRecord } from "../src/store.ts";

const WEB = "mcp__foldrun_scripts__web";

// ------------------------------------------------------------ read or write

test("reads: file reads, search, fetch, a browse that looks, screenshots, GETs, consults", () => {
  for (const [tool, input] of [
    ["Read", { file_path: "/workspace/a.md" }],
    ["Glob", { pattern: "*" }],
    ["Grep", { pattern: "x" }],
    ["WebSearch", {}],
    ["WebFetch", {}],
    ["TodoWrite", { todos: [] }],
    [WEB, { action: "search", query: "x" }],
    [WEB, { action: "fetch", url: "https://x" }],
    [WEB, { action: "browse", url: "https://x", mode: "screenshot" }],
    [WEB, { action: "browse", url: "https://x", actions: JSON.stringify([{ goto: "https://y" }, { scroll: "down" }, { screenshot: "a.png" }, { wait: 500 }, { extract: "h1" }, { hover: "a" }]) }],
    [WEB, { action: "browse", url: "https://x", actions: [{ get: "title" }, { expect: "text=ok" }] }],
    [WEB, { action: "crawl", url: "https://x" }],
    ["mcp__foldrun_apis__call_crm", { method: "GET", path: "/contacts" }],
    ["mcp__foldrun_apis__crm_list_contacts", {}],
    ["mcp__foldrun_search__search_files", { query: "x" }],
    ["mcp__foldrun_agents__consult_editor", { question: "?" }],
    ["Agent", { subagent_type: "r" }],
  ] as const) {
    assert.deepEqual(classifyCall(tool, input as Record<string, unknown>, { methods: { "mcp__foldrun_apis__crm_list_contacts": "GET" } }), { write: false }, `${tool} ${JSON.stringify(input)}`);
  }
});

test("writes: files, shell, scripts, non-GET API calls, paid web, clicks and fills, memory, a question, unknown MCP", () => {
  const w = (tool: string, input: Record<string, unknown> = {}, ctx = {}) => {
    const k = classifyCall(tool, input, ctx);
    assert.equal(k.write, true, `${tool} ${JSON.stringify(input)} is a write`);
    return k.write ? k.what : "";
  };
  assert.match(w("Write", { file_path: "/workspace/state/leads.csv" }), /state\/leads\.csv \(Write\)/);
  assert.match(w("Edit", { file_path: "/workspace/agents/a/memory/notes.md" }), /memory\/notes\.md \(Edit\)/);
  assert.equal(w("Bash", { command: "ls" }), "a shell command");
  assert.equal(w("mcp__foldrun_scripts__desk_email", { to: "x" }), "script desk_email");
  assert.equal(w("mcp__foldrun_apis__call_crm", { method: "POST", path: "/contacts" }), "crm POST");
  assert.equal(w("mcp__foldrun_apis__crm_create_contact", {}, { methods: { "mcp__foldrun_apis__crm_create_contact": "POST" } }), "crm_create_contact POST");
  // A typed operation whose method is not known is a write: when unsure, write.
  assert.equal(w("mcp__foldrun_apis__crm_mystery", {}), "crm_mystery call");
  assert.equal(w(WEB, { action: "monitor", url: "https://x" }), "web monitor state");
  assert.equal(w(WEB, { action: "search", query: "x" }, { paidWeb: { search: "exa" } }), "a paid exa search");
  assert.equal(w(WEB, { action: "browse", url: "https://x", actions: JSON.stringify([{ fill: "#q", value: "x" }, { click: "button" }]) }), "browse fill/click");
  assert.match(w(WEB, { action: "browse", actions: [{ if: { url: "x" }, then: [{ click: "#buy" }] }] }), /click/, "a click inside an if branch is seen");
  assert.match(w(WEB, { action: "browse", url: "https://x", js: "document.forms[0].submit()" }), /js=/);
  assert.match(w(WEB, { action: "browse", actions: "{not json" }), /could not read/, "unreadable actions are a write");
  assert.equal(w("mcp__foldrun_ask__ask_person", { question: "?" }), "a question to a person");
  assert.equal(w("mcp__linear__create_issue", {}), "linear create_issue");
  assert.equal(w("SomethingNew", {}), "SomethingNew");
});

test("a page script is a write, whether the call names it or the agent's web.browse block does", () => {
  const browse = { action: "browse", url: "https://x" };
  const k = classifyCall(WEB, { ...browse, init: "scripts/stub.js" });
  assert.equal(k.write, true, "init= runs a script in every page, as js= does");
  assert.match(k.write ? k.what : "", /init=/);
  const fromBlock = classifyCall(WEB, browse, { browseInit: "scripts/stub.js" });
  assert.equal(fromBlock.write, true, "FOLDRUN_BROWSER_INIT runs it in every browse call of the step");
  assert.match(fromBlock.write ? fromBlock.what : "", /init/);
  assert.deepEqual(classifyCall(WEB, { action: "fetch", url: "https://x" }, { browseInit: "scripts/stub.js" }), { write: false }, "only a browse opens pages");
  assert.deepEqual(classifyCall(WEB, browse, { browseInit: "" }), { write: false });
});

test("every write action is a browse action the tool knows", () => {
  for (const a of BROWSE_WRITE_ACTIONS) assert.ok((WEB_BROWSE_ACTIONS as readonly string[]).includes(a), a);
  assert.deepEqual(browseActionNames([{ click: "a" }, { if: { url: "x" }, then: [{ fill: "b" }] }]).filter((n) => ["click", "fill"].includes(n)), ["click", "fill"]);
});

test("paid web actions come from the step's env", () => {
  assert.deepEqual(paidWebActions({ FOLDRUN_WEB_SEARCH_VIA: "exa", FOLDRUN_WEB_FETCH_VIA: "", OTHER: "x" }), { search: "exa" });
});

test("what the step start can see needs a browser in the step", () => {
  assert.equal(slimBrowseBlocker({}), null);
  assert.equal(slimBrowseBlocker({ FOLDRUN_BROWSER_ENGINE: "chrome", FOLDRUN_BROWSER_HEADLESS: "0" }), null, "chrome and a window are served by the pod");
  assert.match(slimBrowseBlocker({ FOLDRUN_BROWSER_ENGINE: "lightpanda" })!, /lightpanda runs in the step/);
  assert.match(slimBrowseBlocker({ FOLDRUN_BROWSER_ENGINE: "obscura" })!, /obscura/);
  assert.match(slimBrowseBlocker({ FOLDRUN_BROWSER_LIVE: "1" })!, /live/);
  assert.match(slimBrowseBlocker({ FOLDRUN_BROWSER_EXTENSIONS: "ext" })!, /extensions/);
  assert.match(slimBrowseBlocker({ FOLDRUN_BROWSER_VENDOR: "browserbase" })!, /browserbase/);
});

// ----------------------------------------------------------- the decision

test("reads only: re-run on full, with the note; anything written: fail, naming it", () => {
  const rerun = podLossDecision({ reconnects: 3, reconnected: 0, lost: { cause: "lost", detail: "ECONNREFUSED" }, writes: [] });
  assert.equal(rerun.rerun, true);
  assert.ok(rerun.rerun && rerun.note.startsWith(RERAN_ON_FULL));
  const fail = podLossDecision({ reconnects: 3, reconnected: 0, lost: { cause: "lost", detail: "socket hang up" }, writes: ["state/x.csv (Write)", "crm POST"] });
  assert.equal(fail.rerun, false);
  assert.ok(!fail.rerun && fail.message.startsWith("browser pod died after the step had written state/x.csv (Write) and crm POST"));
  assert.match(!fail.rerun ? fail.message : "", /retry:, on-fail: or a person decides/);
  const needs = podLossDecision({ reconnects: 0, reconnected: 0, lost: { cause: "needs-full", detail: "engine lightpanda runs inside the step" }, writes: ["a shell command"] });
  assert.ok(!needs.rerun && /needed a browser in the step after the step had written a shell command/.test(needs.message));
  assert.equal(describeWrites(["a", "b", "c", "d", "e"]), "a, b, c and 2 more");
  assert.equal(describeWrites(["a", "a"]), "a");
});

test("the pod log is read line by line; a torn line waits", () => {
  const text = '{"kind":"reconnect","attempt":1,"of":3,"ok":false}\nnoise\n{"kind":"lost","ran":false,"error":"gone"}\n{"kind":"reco';
  const first = readPodEvents(text, 0);
  assert.equal(first.events.length, 2);
  assert.equal(first.events[1].kind, "lost");
  assert.equal(first.next, text.lastIndexOf("\n") + 1);
  const later = readPodEvents(text + 'nnect","attempt":2,"of":3,"ok":true}\n', first.next);
  assert.deepEqual(later.events.map((e) => [e.kind, e.ok]), [["reconnect", true]]);
});

test("the outcome crosses the sandbox boundary checked, and reads as one line", () => {
  const line = JSON.stringify({ e: "done", status: "failed", result: null, costUsd: 0.1, browserPod: { reconnects: 3, reconnected: 1, lost: { cause: "lost", detail: "x" }, writes: ["a (Write)"] } });
  const parsed = parseDriverLine(line) as ContainerStepOutcome;
  assert.deepEqual(parsed.browserPod, { reconnects: 3, reconnected: 1, lost: { cause: "lost", detail: "x" }, writes: ["a (Write)"] });
  assert.equal(parseBrowserPod("nope"), null);
  assert.deepEqual(parseBrowserPod({ reconnects: -4, lost: { cause: "other" } }), { reconnects: 0, reconnected: 0 });
  assert.equal(browserPodLine({ reconnects: 2, reconnected: 2 }), "2 reconnects (2 got through)");
  assert.equal(browserPodLine({ reconnects: 3, reconnected: 0, lost: { cause: "lost", detail: "gone" }, fallback: RERAN_ON_FULL }), "3 reconnects; browser pod lost; re-ran on full (gone)");
  const crossed = parseBrowserPod({ reconnects: 1, reconnected: 0, closedAgain: 1, lost: { cause: "lost", detail: "x" } });
  assert.equal(crossed?.closedAgain, 1, "closedAgain crosses too");
});

test("a lost pod's line never says a reconnect got through; one that reached the pod and closed again says so", () => {
  // run-mupfupae-h2jj on dev, 2026-10-01: the reconnect reached the pod as
  // it terminated and the call dropped again at once. The line read
  // "1 reconnect (1 got through); pod lost: …".
  assert.equal(
    browserPodLine({ reconnects: 1, reconnected: 0, closedAgain: 1, lost: { cause: "lost", detail: "browser has been closed" } }),
    "1 reconnect, which reached the pod but it closed again; pod lost: browser has been closed",
  );
  assert.equal(
    browserPodLine({ reconnects: 2, reconnected: 0, closedAgain: 1, lost: { cause: "lost", detail: "gone" }, fallback: RERAN_ON_FULL }),
    "2 reconnects, the last reached the pod but it closed again; browser pod lost; re-ran on full (gone)",
  );
  // An earlier reconnect a call did get through on — still not "got
  // through" on a pod that was lost in the end.
  assert.doesNotMatch(browserPodLine({ reconnects: 4, reconnected: 1, lost: { cause: "lost", detail: "ECONNREFUSED" } }), /got through/);
  assert.equal(browserPodLine({ reconnects: 0, reconnected: 0, lost: { cause: "lost", detail: "gone" } }), "no reconnects; pod lost: gone");
});

// --------------------------------------------- the model loop, pod dying

/** A fake model loop: each scripted call is a tool_use then its tool_result;
 *  `during` runs between them — where the web tool would write its log. */
function scripted(calls: { id: string; name: string; input: Record<string, unknown>; during?: () => void }[], seen: { interrupted: boolean }): QueryFn {
  return () => {
    const gen = (async function* () {
      for (const c of calls) {
        yield { type: "assistant", message: { id: `m-${c.id}`, content: [{ type: "tool_use", id: c.id, name: c.name, input: c.input }], usage: { input_tokens: 10, output_tokens: 5 } } };
        c.during?.();
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: c.id, content: "ok" }] } };
      }
      yield { type: "assistant", message: { id: "m-end", content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, output_tokens: 5 } } };
      yield { type: "result", subtype: "success", total_cost_usd: 0.01, usage: { input_tokens: 30, output_tokens: 15 } };
    })();
    return Object.assign(gen, { interrupt: async () => { seen.interrupted = true; } });
  };
}

function stepDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-pod-"));
  const agentDir = path.join(root, "agents/a");
  fs.mkdirSync(agentDir, { recursive: true });
  return { root, agentDir, events: path.join(root, "pod.jsonl") };
}
const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";

async function runScripted(calls: Parameters<typeof scripted>[0], events: string, root: string, agentDir: string) {
  const seen = { interrupted: false };
  const lines: string[] = [];
  const out = await executeStep({
    agentDir, workspaceRoot: root, libraryRoot: root, prompt: "p", model: "m", systemPrompt: "s",
    allowed: ["Read", "Write", WEB], mcpNames: [], mcpServers: {}, env: {},
    browserPod: { events },
    emit: (_t, text) => lines.push(text),
  }, scripted(calls, seen));
  return { out, seen, lines };
}

test("the pod dies mid-step after reads only: the step stops, failed, with nothing written", async () => {
  const { root, agentDir, events } = stepDirs();
  const { out, seen, lines } = await runScripted([
    { id: "t1", name: "Read", input: { file_path: "knowledge/a.md" } },
    { id: "t2", name: WEB, input: { action: "browse", url: "https://x", mode: "text" } },
    {
      id: "t3", name: WEB, input: { action: "browse", url: "https://y", actions: [{ click: "#next" }] },
      // The pod went before this call reached it: three tries, none through.
      during: () => fs.appendFileSync(events,
        line({ kind: "reconnect", attempt: 1, of: 3, ok: false, error: "ECONNREFUSED" }) +
        line({ kind: "reconnect", attempt: 2, of: 3, ok: false, error: "ECONNREFUSED" }) +
        line({ kind: "reconnect", attempt: 3, of: 3, ok: false, error: "ECONNREFUSED" }) +
        line({ kind: "lost", ran: false, error: "ECONNREFUSED" })),
    },
    { id: "t4", name: "Write", input: { file_path: "state/never.md" } },
  ], events, root, agentDir);
  assert.equal(out.status, "failed");
  assert.equal(seen.interrupted, true, "the step was stopped");
  assert.deepEqual(out.browserPod?.lost, { cause: "lost", detail: "ECONNREFUSED" });
  assert.equal(out.browserPod?.reconnects, 3);
  assert.equal(out.browserPod?.reconnected, 0);
  assert.deepEqual(out.browserPod?.writes, [], "the click never reached a page, and the Write after it never ran");
  assert.ok(lines.some((l) => /browser pod: reconnect failed \(try 1 of 3\)/.test(l)));
  assert.ok(lines.some((l) => /browser pod: lost after 3 reconnect tries/.test(l)));
  assert.equal(podLossDecision(out.browserPod!).rerun, true);
});

test("the pod dies mid-call after the step wrote: the writes are named", async () => {
  const { root, agentDir, events } = stepDirs();
  const { out } = await runScripted([
    { id: "t1", name: "Write", input: { file_path: "/workspace/state/leads.csv" } },
    {
      id: "t2", name: WEB, input: { action: "browse", url: "https://x", actions: JSON.stringify([{ fill: "#email", value: "a@b" }, { click: "submit" }]) },
      during: () => fs.appendFileSync(events, line({ kind: "lost", ran: true, error: "browser has been closed" })),
    },
  ], events, root, agentDir);
  assert.equal(out.status, "failed");
  assert.deepEqual(out.browserPod?.writes, ["state/leads.csv (Write)", "browse fill/click"]);
  const d = podLossDecision(out.browserPod!);
  assert.ok(!d.rerun && d.message.startsWith("browser pod died after the step had written state/leads.csv (Write) and browse fill/click"));
});

test("a reconnect that gets through is counted and the step carries on", async () => {
  const { root, agentDir, events } = stepDirs();
  const { out, seen, lines } = await runScripted([
    { id: "t1", name: WEB, input: { action: "browse", url: "https://x" }, during: () => fs.appendFileSync(events, line({ kind: "reconnect", attempt: 1, of: 3, ok: false, error: "reset" }) + line({ kind: "reconnect", attempt: 2, of: 3, ok: true })) },
    { id: "t2", name: WEB, input: { action: "fetch", url: "https://y" } },
  ], events, root, agentDir);
  assert.equal(out.status, "completed");
  assert.equal(seen.interrupted, false);
  assert.deepEqual(out.browserPod, { reconnects: 2, reconnected: 1 });
  assert.ok(lines.some((l) => l === "browser pod: reconnected (try 2 of 3)"));
});

test("a reconnect that reaches a closing pod, then the call drops again: not counted as through, and the log says the pod closed again", async () => {
  // run-mupfydqa-niso on dev, 2026-10-01: "browser pod: reconnected (try 1
  // of 3)" then at once "lost after 1 reconnect try".
  const { root, agentDir, events } = stepDirs();
  const { out, lines } = await runScripted([
    {
      id: "t1", name: WEB, input: { action: "browse", url: "https://x", mode: "text" },
      during: () => fs.appendFileSync(events,
        line({ kind: "reconnect", attempt: 1, of: 3, ok: true, at: "2026-10-01T10:15:15.000Z" }) +
        line({ kind: "lost", ran: true, error: "browser has been closed", at: "2026-10-01T10:15:16.000Z" })),
    },
  ], events, root, agentDir);
  assert.equal(out.status, "failed");
  assert.equal(out.browserPod?.reconnects, 1);
  assert.equal(out.browserPod?.reconnected, 0, "a call never got through on it");
  assert.equal(out.browserPod?.closedAgain, 1);
  assert.ok(lines.includes("browser pod: reconnected (try 1 of 3, at 10:15:15Z), but the pod closed again"), lines.join("\n"));
  assert.ok(lines.includes("browser pod: lost — the call dropped again after the reconnect (browser has been closed, at 10:15:16Z) — stopping the step"), lines.join("\n"));
  assert.ok(!lines.some((l) => /lost after 1 reconnect try/.test(l)));
  assert.equal(browserPodLine(out.browserPod!), "1 reconnect, which reached the pod but it closed again; pod lost: browser has been closed");
});

test("a call that needs a browser in the step stops a slim step the same way", async () => {
  const { root, agentDir, events } = stepDirs();
  const { out } = await runScripted([
    { id: "t1", name: WEB, input: { action: "browse", url: "https://x", engine: "lightpanda" }, during: () => fs.appendFileSync(events, line({ kind: "needs-full", ran: false, why: "lightpanda runs inside the step" })) },
  ], events, root, agentDir);
  assert.equal(out.status, "failed");
  assert.deepEqual(out.browserPod?.lost, { cause: "needs-full", detail: "lightpanda runs inside the step" });
  assert.equal(podLossDecision(out.browserPod!).rerun, true);
});

test("no browserPod option, no ledger and no field", async () => {
  const { root, agentDir } = stepDirs();
  const out = await executeStep({
    agentDir, workspaceRoot: root, libraryRoot: root, prompt: "p", model: "m", systemPrompt: "s",
    allowed: [WEB], mcpNames: [], mcpServers: {}, env: {}, emit: () => {},
  }, scripted([{ id: "t1", name: WEB, input: { action: "browse", url: "https://x" } }], { interrupted: false }));
  assert.equal(out.status, "completed");
  assert.equal(out.browserPod, undefined);
});

// --------------------------------------------------------------- the runner

type Fake = (args: RunInContainerArgs) => Promise<ContainerStepOutcome>;

async function withFake(fake: Fake, files: Record<string, string>, body: () => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-podrun-"));
  const prev = { data: process.env.FOLDRUN_DATA, iso: process.env.FOLDRUN_RUN_ISOLATION };
  process.env.FOLDRUN_DATA = root;
  process.env.FOLDRUN_RUN_ISOLATION = "fake";
  const prevIso = platform.isolation;
  registerPlatform({ isolation: { fake } });
  try {
    const ws = path.join(root, "acme/workspaces/desk");
    fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      fs.writeFileSync(path.join(ws, rel), text);
    }
    await body();
  } finally {
    registerPlatform({ isolation: prevIso });
    for (const [k, v] of [["FOLDRUN_DATA", prev.data], ["FOLDRUN_RUN_ISOLATION", prev.iso]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const AGENT = { "agents/worker/agent.md": "---\nname: worker\ndescription: browses\ntools: [web]\n---\n\nBrowse.\n" };
const step = (extra: Partial<FlowStep> = {}): FlowStep => ({ agent: "worker", instruction: "look", group: 1, optional: false, ...extra });
const slim = { variant: "slim" as const, why: "browses through the account's browser pod", pod: true };

test("runner: pod lost after reads only — the step runs again from the start on the full image, and the run says so", async () => {
  const inputs: RunInContainerArgs["input"][] = [];
  const fake: Fake = async (args) => {
    inputs.push(args.input);
    if (inputs.length === 1) {
      return {
        status: "failed", result: null, costUsd: 0.01, usage: { inputTokens: 100, outputTokens: 10 }, image: slim,
        browserPod: { reconnects: 3, reconnected: 0, lost: { cause: "lost", detail: "ECONNREFUSED" }, writes: [] },
        timing: { sandboxMs: 100, firstOutputMs: null, totalMs: 3000 },
      };
    }
    return { status: "completed", result: "found it", costUsd: 0.02, usage: { inputTokens: 200, outputTokens: 20 }, image: { variant: "full", why: "re-run after the browser pod was lost" }, timing: { sandboxMs: 100, firstOutputMs: null, totalMs: 5000 } };
  };
  await withFake(fake, AGENT, async () => {
    const run = startFlowRun("acme", "desk", [step()], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed");
    assert.equal(inputs.length, 2, "one re-run");
    assert.equal(inputs[0].image, undefined, "the first attempt lets the executor choose");
    assert.equal(inputs[1].image, "full", "the re-run is pinned to the full image");
    const s = done!.steps[0];
    assert.equal(s.attempts, 1, "the re-run is part of the attempt, not a retry: of it");
    assert.equal(s.image?.variant, "full");
    assert.equal(s.browserPod?.fallback, RERAN_ON_FULL);
    assert.equal(s.browserPod?.reconnects, 3);
    assert.ok(s.events.some((e) => e.type === "info" && e.text.startsWith(RERAN_ON_FULL)), "the run says it");
    assert.ok(Math.abs((s.costUsd ?? 0) - 0.03) < 1e-6, `both attempts are paid for: ${s.costUsd}`);
    assert.equal(s.computeSecs, 8);
    // Two tries on the record: the slim go the pod was lost under, then the
    // full one (live, 2026-10-01, the record showed only the full one).
    assert.equal(s.tries?.length, 2, JSON.stringify(s.tries));
    const [lost, full] = s.tries!;
    assert.equal(lost.status, "lost");
    assert.equal(lost.image, "slim");
    assert.equal(lost.n, 1);
    assert.ok(Math.abs((lost.costUsd ?? 0) - 0.01) < 1e-9, `the slim go's own cost: ${lost.costUsd}`);
    assert.deepEqual(lost.tokens, { input: 100, output: 10 });
    assert.equal(lost.computeSecs, 3);
    assert.equal(lost.browserPod, "3 reconnects; pod lost: ECONNREFUSED");
    assert.match(lost.error ?? "", /^browser pod lost; re-ran on full/);
    assert.equal(full.status, "completed");
    assert.equal(full.image, "full");
    assert.equal(full.n, 2, "the full re-run is the second try");
    assert.equal(full.attempt, 1, "of the step's first attempt");
    assert.equal(lost.attempt, undefined, "n is the attempt; nothing more to say");
    assert.ok(Math.abs((full.costUsd ?? 0) - 0.02) < 1e-9, `the full go's own cost: ${full.costUsd}`);
    assert.equal(full.computeSecs, 5);
    assert.match(full.browserPod ?? "", /re-ran on full/);
    assert.ok(Date.parse(full.startedAt) >= Date.parse(lost.finishedAt), "the full go starts where the slim one was lost");
    assert.equal(s.podLostTry, undefined, "nothing left set aside");
  });
});

test("runner: the live reader sequence — a reconnect that got through, then the pod gone — records slim (lost) then full", async () => {
  // run-mupdjcjl-u2y9 on dev, 2026-10-01: call 2 met the closed browser and
  // reconnected; call 5's three reconnects were refused; re-ran on full.
  let n = 0;
  const fake: Fake = async () => {
    n += 1;
    if (n === 1) {
      return {
        status: "failed", result: null, costUsd: 0.004, usage: { inputTokens: 40, outputTokens: 4 }, image: slim,
        browserPod: { reconnects: 4, reconnected: 1, lost: { cause: "lost", detail: "connect ECONNREFUSED 10.43.12.163:3000" }, writes: [] },
        timing: { sandboxMs: 100, firstOutputMs: null, totalMs: 40_000 },
      };
    }
    return { status: "completed", result: "ok", costUsd: 0.006, usage: { inputTokens: 60, outputTokens: 6 }, image: { variant: "full", why: "re-run after the browser pod was lost" }, timing: { sandboxMs: 100, firstOutputMs: null, totalMs: 50_000 } };
  };
  await withFake(fake, AGENT, async () => {
    const run = startFlowRun("acme", "desk", [step()], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    const s = done!.steps[0];
    assert.deepEqual(s.tries?.map((t) => [t.image, t.status]), [["slim", "lost"], ["full", "completed"]]);
    assert.equal(s.tries?.[0].browserPod, "4 reconnects; pod lost: connect ECONNREFUSED 10.43.12.163:3000");
    assert.ok(Math.abs((s.costUsd ?? 0) - 0.01) < 1e-9);
    assert.equal(s.computeSecs, 90);
  });
});

test("runner: the full re-run throws — its failed row says full, after the slim (lost) one", async () => {
  // The step's image was set from the slim outcome before the re-run, and a
  // re-run that threw (the executor could not start the full sandbox) never
  // reached the line that sets it again: the failed row read "slim".
  let n = 0;
  const fake: Fake = async () => {
    n += 1;
    if (n === 1) {
      return {
        status: "failed", result: null, costUsd: 0.01, usage: { inputTokens: 100, outputTokens: 10 }, image: slim,
        browserPod: { reconnects: 3, reconnected: 0, lost: { cause: "lost", detail: "ECONNREFUSED" }, writes: [] },
        timing: { sandboxMs: 100, firstOutputMs: null, totalMs: 3000 },
      };
    }
    throw new Error("full image pull failed");
  };
  await withFake(fake, AGENT, async () => {
    const run = startFlowRun("acme", "desk", [step()], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "failed");
    assert.equal(n, 2, "the re-run was tried");
    const s = done!.steps[0];
    assert.deepEqual(s.tries?.map((t) => [t.image, t.status]), [["slim", "lost"], ["full", "failed"]], JSON.stringify(s.tries));
    assert.equal(s.image?.variant, "full");
    assert.equal(s.browserPod?.fallback, RERAN_ON_FULL);
  });
});

test("recordAttempt: a re-attached attempt replaces its rows, the lost one too", () => {
  const s = { events: [], costUsd: 0.02, tokens: null, computeSecs: 5, finishedAt: "2026-10-01T10:13:00.000Z" } as unknown as StepRecord;
  s.podLostTry = { status: "lost", costUsd: 0.01, tokens: null, computeSecs: 3, finishedAt: "2026-10-01T10:12:30.000Z", image: "slim", browserPod: "x" };
  recordAttempt(s, 1, "completed", "2026-10-01T10:11:00.000Z", 0);
  assert.deepEqual(s.tries?.map((t) => [t.n, t.status, t.startedAt]), [[1, "lost", "2026-10-01T10:11:00.000Z"], [2, "completed", "2026-10-01T10:12:30.000Z"]]);
  assert.ok(Math.abs((s.costUsd ?? 0) - 0.03) < 1e-9);
  s.costUsd = 0.02; s.computeSecs = 5;
  s.podLostTry = { status: "lost", costUsd: 0.01, tokens: null, computeSecs: 3, finishedAt: "2026-10-01T10:12:30.000Z", image: "slim", browserPod: "x" };
  recordAttempt(s, 1, "completed", "2026-10-01T10:11:00.000Z", 0, true);
  assert.equal(s.tries?.length, 2, "replaced, not repeated");
  assert.deepEqual(s.tries?.map((t) => t.n), [1, 2]);
});

test("recordAttempt: tries are numbered in order — a retry after a lost slim go and its full re-run is try 3, of attempt 2", () => {
  const s = { events: [], costUsd: 0.02, tokens: null, computeSecs: 5, finishedAt: "2026-10-01T10:13:00.000Z" } as unknown as StepRecord;
  s.podLostTry = { status: "lost", costUsd: 0.01, tokens: null, computeSecs: 3, finishedAt: "2026-10-01T10:12:30.000Z", image: "slim", browserPod: "x" };
  recordAttempt(s, 1, "failed", "2026-10-01T10:11:00.000Z", 0);
  s.costUsd = 0.03; s.computeSecs = 4; s.finishedAt = "2026-10-01T10:15:00.000Z";
  recordAttempt(s, 2, "completed", "2026-10-01T10:14:00.000Z", 0);
  assert.deepEqual(s.tries?.map((t) => [t.n, t.attempt ?? t.n, t.status]), [[1, 1, "lost"], [2, 1, "failed"], [3, 2, "completed"]]);
  // A driver that re-attaches to attempt 2's sandbox replaces attempt 2's row only.
  s.costUsd = 0.03; s.computeSecs = 4;
  recordAttempt(s, 2, "completed", "2026-10-01T10:14:00.000Z", 0, true);
  assert.deepEqual(s.tries?.map((t) => t.n), [1, 2, 3]);
  assert.ok(Math.abs((s.costUsd ?? 0) - 0.06) < 1e-9, `${s.costUsd}`);
});

test("runner: pod lost after a write — no re-run; the step fails naming what was written", async () => {
  let calls = 0;
  const fake: Fake = async () => {
    calls += 1;
    return {
      status: "failed", result: null, costUsd: 0.01, image: slim,
      browserPod: { reconnects: 3, reconnected: 0, lost: { cause: "lost", detail: "socket hang up" }, writes: ["state/leads.csv (Write)"] },
    };
  };
  await withFake(fake, AGENT, async () => {
    const run = startFlowRun("acme", "desk", [step()], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "failed");
    assert.equal(calls, 1, "not re-run");
    const s = done!.steps[0];
    assert.equal(s.image?.variant, "slim");
    assert.equal(s.image?.pod, true);
    assert.match(s.browserPod?.failure ?? "", /^browser pod died after the step had written state\/leads\.csv \(Write\)/);
    assert.ok(s.events.some((e) => e.type === "error" && /browser pod died after the step had written state\/leads\.csv/.test(e.text)));
    assert.match(s.tries?.[0].error ?? "", /browser pod died after the step had written/);
  });
});

test("runner: retry: still applies to a step that failed after writing — the person's policy decides", async () => {
  let calls = 0;
  const fake: Fake = async () => {
    calls += 1;
    if (calls === 1) return { status: "failed", result: null, costUsd: 0.01, image: slim, browserPod: { reconnects: 3, reconnected: 0, lost: { cause: "lost", detail: "gone" }, writes: ["a shell command"] } };
    return { status: "completed", result: "ok", costUsd: 0.01, image: slim, browserPod: { reconnects: 0, reconnected: 0 } };
  };
  await withFake(fake, AGENT, async () => {
    process.env.FOLDRUN_RETRY_BASE_MS = "20";
    try {
      const run = startFlowRun("acme", "desk", [step({ retry: 1 })], "f");
      const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
      assert.equal(done?.status, "completed");
      assert.equal(calls, 2);
      assert.equal(done!.steps[0].browserPod?.failure, undefined, "the record is the last attempt's");
      assert.match(done!.steps[0].tries?.[0].browserPod ?? "", /browser pod died/);
    } finally {
      delete process.env.FOLDRUN_RETRY_BASE_MS;
    }
  });
});

test("runner: a step granting an outward tool is marked outward, so the executor keeps it on full", async () => {
  const inputs: RunInContainerArgs["input"][] = [];
  const fake: Fake = async (args) => {
    inputs.push(args.input);
    return { status: "completed", result: "sent", costUsd: 0.01 };
  };
  await withFake(fake, {
    "agents/worker/agent.md": "---\nname: worker\ndescription: posts\ntools: [web, poster]\n---\n\nPost.\n",
    "tools/poster/tool.md": "---\nname: poster\ndescription: posts\nrun: run.mjs\noutward: true\n---\n",
    "tools/poster/run.mjs": "console.log('posted')\n",
    "agents/reader/agent.md": "---\nname: reader\ndescription: reads\ntools: [web]\n---\n\nRead.\n",
  }, async () => {
    const run = startFlowRun("acme", "desk", [step(), { agent: "reader", instruction: "read", group: 2, optional: false }], "f");
    const { run: done } = await waitForRun("acme", "desk", run.id, 20_000);
    assert.equal(done?.status, "completed");
    assert.equal(inputs[0].outward, true);
    assert.equal(inputs[1].outward, undefined);
  });
});

test("the tries line: only when a try was lost; slim (lost) then full, with each one's cost", () => {
  assert.equal(podTriesLine(undefined), null);
  assert.equal(podTriesLine([{ n: 1, status: "completed", image: "full", costUsd: 0.02 }]), null);
  assert.equal(
    podTriesLine([{ n: 1, status: "lost", image: "slim", costUsd: 0.004 }, { n: 2, status: "completed", image: "full", costUsd: 0.006 }]),
    "#1 slim · lost · $0.0040 → #2 full · completed · $0.0060",
  );
  assert.equal(
    podTriesLine([{ n: 1, status: "failed", image: "full", costUsd: null }, { n: 2, status: "lost", image: "slim", costUsd: 0.01 }, { n: 3, status: "completed", image: "full", costUsd: 0.02 }]),
    "#1 full · failed → #2 slim · lost · $0.0100 → #3 full · completed · $0.0200",
  );
});

test("a pod log line's time, for the run's reconnect lines", () => {
  assert.equal(podAt("2026-10-01T10:15:15.123Z"), ", at 10:15:15Z");
  assert.equal(podAt(undefined), "");
  assert.equal(podAt("not a time"), "");
});

test("an option object's keys are not actions — only a step's own keys and its then/else steps are", () => {
  // The web tool reads a step's action from the step's own keys (the first
  // it knows) and recurses only into an `if`'s then/else. Keys inside an
  // option's value — extract's fields, a mock's json body, a webmcp input —
  // are column names, data and arguments, never something done to the page.
  for (const actions of [
    [{ extract: ".row", fields: { type: "td.kind", select: "td.choice", check: "td.ok" } }],
    [{ mock: "**/api/prices", json: { type: "png", clear: true, press: 1 } }],
    [{ localstorage: "prefs", value: { select: "all" } }],
    [{ if: "url", contains: "/p/", then: [{ extract: "h1", fields: { type: "h2" } }] }],
  ]) {
    assert.deepEqual(classifyCall(WEB, { action: "browse", url: "https://x", actions: JSON.stringify(actions) }), { write: false }, JSON.stringify(actions));
  }
});

test("every real write still reads as one: a step's own key, then/else at any depth, unknown shapes", () => {
  const w = (actions: unknown) => {
    const k = classifyCall(WEB, { action: "browse", url: "https://x", actions });
    assert.equal(k.write, true, JSON.stringify(actions));
    return k.write ? k.what : "";
  };
  for (const a of BROWSE_WRITE_ACTIONS) assert.match(w([{ [a]: "x" }]), new RegExp(a));
  // A write key beside a read key: the tool may take either, so it is a write.
  assert.match(w([{ screenshot: "a.png", type: "hello" }]), /type/);
  assert.match(w([{ extract: ".row", fields: { name: "h3" }, click: "a" }]), /click/);
  assert.match(w([{ if: "url", contains: "x", then: [{ hover: "a" }], else: [{ if: "title", equals: "y", then: [{ fill: "#q", value: "v" }] }] }]), /fill/);
  // Shapes the tool would refuse are still read the old way: any key counts.
  assert.match(w({ click: "a" }), /click/, "an object where an array belongs");
  assert.match(w([{ if: "url", then: { click: "a" } }]), /click/, "then as an object");
  assert.match(w([[{ click: "a" }]]), /click/, "a step that is an array");
  // A click twelve ifs down is still a click (the old walk stopped at 8
  // levels of JSON, about four ifs, and read it as a read).
  const nest = (inner: unknown, n: number) => { let v = inner; for (let i = 0; i < n; i++) v = [{ if: "url", then: v }]; return v; };
  assert.match(w(nest([{ click: "#buy" }], 12)), /click/);
  // Nested past what is read: unreadable, so a write, not a silent read.
  assert.match(w(nest([{ hover: "a" }], 40)), /could not read/);
  assert.deepEqual(classifyCall(WEB, { action: "browse", url: "https://x", actions: nest([{ hover: "a" }], 12) }), { write: false });
});
