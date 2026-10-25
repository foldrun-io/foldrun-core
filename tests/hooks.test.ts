// Hooks: the person's own code at foldrun's tool dispatch (src/hooks.ts and
// the PreToolUse / PostToolUse callbacks in step-exec.ts).
//
// The fake SDK below keeps the SDK's contract: it asks the PreToolUse
// callback before a call, runs nothing that was denied, and hands the result
// to PostToolUse. Every provider goes through that same loop (another
// provider is the translator underneath it), which is what case (a) holds.
//
//   npx tsx --test tests/hooks.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeStep, type QueryFn, type ExecOptions } from "../src/step-exec.ts";
import { matchesTool, parseAnswer, readHookDef, resolveHooks, runHook, runToolCallHooks, isHookRecord, checkHooksDir, type HookDef } from "../src/hooks.ts";

type Decision = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } };
type Cb = (i: unknown, id?: string, o?: { signal: AbortSignal }) => Promise<Decision>;
interface Fake { pre: (tool: string, input: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<Decision>; post: (tool: string, input: Record<string, unknown>, response: unknown) => Promise<unknown>; prompt: string }

function workspace(): { ws: string; agentDir: string; done: () => void } {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-hooks-")));
  const agentDir = path.join(ws, "agents", "scout");
  fs.mkdirSync(agentDir, { recursive: true });
  return { ws, agentDir, done: () => fs.rmSync(ws, { recursive: true, force: true }) };
}

function hook(ws: string, name: string, front: string, code: string) {
  const dir = path.join(ws, "hooks", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hook.md"), `---\n${front}\n---\n\nA test hook.\n`);
  fs.writeFileSync(path.join(dir, "run.mjs"), code);
  return dir;
}

/** One step through executeStep with a fake model loop that runs `body`. */
async function step(
  w: { ws: string; agentDir: string },
  hookNames: string[],
  body: (f: Fake) => Promise<void>,
  over: Partial<ExecOptions> = {},
) {
  const events: { type: string; text: string; extra?: Record<string, unknown> }[] = [];
  let failure: unknown = null;
  const query: QueryFn = ({ prompt, options }) => {
    const h = (options as { hooks: { PreToolUse: { hooks: Cb[] }[]; PostToolUse?: { hooks: Cb[] }[] } }).hooks;
    const signal = new AbortController().signal;
    const f: Fake = {
      prompt,
      pre: (tool, input, extra = {}) => h.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, ...extra }, "t", { signal }),
      post: (tool, input, response) => h.PostToolUse![0].hooks[0]({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_response: response }, "t", { signal }),
    };
    return Object.assign((async function* () {
      try { await body(f); } catch (e) { failure = e; }
      yield { type: "assistant", message: { content: [{ type: "text", text: "the model's answer" }] } };
      yield { type: "result", subtype: "success", result: "the model's answer", total_cost_usd: 0 };
    })(), { async interrupt() {} });
  };
  const out = await executeStep({
    agentDir: w.agentDir, workspaceRoot: w.ws, libraryRoot: path.join(w.ws, "no-library"),
    prompt: "do the task", model: "haiku", systemPrompt: "s", allowed: ["Bash", "Read", "Write"], mcpNames: [], mcpServers: {}, env: {},
    hookNames, emit: (type, text, extra) => events.push({ type, text, extra: extra as Record<string, unknown> }),
    ...over,
  }, query);
  if (failure) throw failure;
  return { out, events };
}

const DENY_RM = `
let s = ""; for await (const c of process.stdin) s += c;
const e = JSON.parse(s);
if (/\\brm\\b/.test(e.tool.input.command ?? "")) console.log(JSON.stringify({ decision: "deny", reason: "no rm in this desk" }));
else console.log(JSON.stringify({ decision: "allow" }));
`;

// ------------------------------------------------------------------ (a)

test("one hook gives the same deny on Claude and on a translated provider", async () => {
  const w = workspace();
  try {
    hook(w.ws, "no-rm", "on: tool.call\ntool: Bash", DENY_RM);
    const seen: Decision[] = [];
    const providers: Partial<ExecOptions>[] = [
      { model: "claude-sonnet-4-5", env: { ANTHROPIC_API_KEY: "sk-ant-x" } },
      // Another provider: the same SDK loop, the translator behind a base URL.
      { model: "gpt-5", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9/translate", FOLDRUN_MODEL_KEY: "sk-openai-x", FOLDRUN_PROVIDER: "openai" } },
    ];
    for (const p of providers) {
      await step(w, ["no-rm"], async (f) => {
        seen.push(await f.pre("Bash", { command: "rm -rf outputs" }));
        assert.deepEqual(await f.pre("Bash", { command: "ls outputs" }), {}, "an allowed call goes on to canUseTool untouched");
      }, p);
    }
    assert.equal(seen.length, 2);
    assert.equal(seen[0].hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(seen[0].hookSpecificOutput?.permissionDecisionReason, "hook no-rm: no rm in this desk");
    assert.deepEqual(seen[0], seen[1], "identical on both providers");
  } finally { w.done(); }
});

// ------------------------------------------------------------------ (b)

test("a hook that throws refuses the call (fail closed)", async () => {
  const w = workspace();
  try {
    hook(w.ws, "broken", "on: tool.call", `throw new Error("boom");`);
    const { events } = await step(w, ["broken"], async (f) => {
      const d = await f.pre("Bash", { command: "ls" });
      assert.equal(d.hookSpecificOutput?.permissionDecision, "deny");
      assert.match(d.hookSpecificOutput!.permissionDecisionReason!, /^hook broken failed \(exited 1: .*boom.*\), so the call is refused$/);
    });
    assert.ok(events.some((e) => e.type === "error" && (e.extra?.hook as { did?: string })?.did === "error"));
  } finally { w.done(); }
});

test("a hook that times out refuses the call, and what it started is killed", async () => {
  const w = workspace();
  try {
    const pidFile = path.join(w.agentDir, "child.pid");
    hook(w.ws, "slow", "on: tool.call\ntimeout: 1", `
import { spawn } from "node:child_process";
import fs from "node:fs";
const c = spawn("sleep", ["30"], { stdio: "ignore" });
fs.writeFileSync("child.pid", String(c.pid));
setInterval(() => {}, 1000);
`);
    const started = Date.now();
    await step(w, ["slow"], async (f) => {
      const d = await f.pre("Bash", { command: "ls" });
      assert.equal(d.hookSpecificOutput?.permissionDecision, "deny");
      assert.match(d.hookSpecificOutput!.permissionDecisionReason!, /timed out after 1s/);
    });
    assert.ok(Date.now() - started < 10_000);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => process.kill(pid, 0), "the hook's own child is gone too");
  } finally { w.done(); }
});

test("a deny with no reason is refused anyway; exit 2 denies with stderr as the reason", async () => {
  const w = workspace();
  try {
    hook(w.ws, "mute", "on: tool.call", `console.log(JSON.stringify({ decision: "deny" }));`);
    hook(w.ws, "exit2", "on: tool.call\ntool: Write", `process.stderr.write("writes are closed today\\n"); process.exit(2);`);
    hook(w.ws, "exit2-quiet", "on: tool.call\ntool: Read", `process.exit(2);`);
    await step(w, ["exit2", "exit2-quiet"], async (f) => {
      const d = await f.pre("Write", { file_path: path.join(w.agentDir, "outputs/x.md"), content: "x" });
      assert.equal(d.hookSpecificOutput?.permissionDecisionReason, "hook exit2: writes are closed today");
      const q = await f.pre("Read", { file_path: path.join(w.agentDir, "outputs/x.md") });
      assert.equal(q.hookSpecificOutput?.permissionDecisionReason, "hook exit2-quiet: exit2-quiet refused it");
    });
    await step(w, ["mute"], async (f) => {
      const d = await f.pre("Bash", { command: "ls" });
      assert.equal(d.hookSpecificOutput?.permissionDecision, "deny");
      assert.match(d.hookSpecificOutput!.permissionDecisionReason!, /a deny needs a reason/);
    });
  } finally { w.done(); }
});

// ------------------------------------------------------------------ (c)

test("a rewrite reaches the tool; a rewrite that escapes the workspace is denied", async () => {
  const w = workspace();
  try {
    hook(w.ws, "rewrite", "on: tool.call", `
let s = ""; for await (const c of process.stdin) s += c;
const e = JSON.parse(s);
const to = { "safe": { command: "echo safe" }, "escape": { command: "cat ../../secrets.json" },
  "read-out": { file_path: "/etc/passwd" }, "abs": { command: "cat /etc/passwd" } }[e.tool.input.tag];
console.log(JSON.stringify(to ? { input: to, reason: "rewritten" } : {}));
`);
    const { events } = await step(w, ["rewrite"], async (f) => {
      const ok = await f.pre("Bash", { command: "rm x", tag: "safe" });
      assert.equal(ok.hookSpecificOutput?.permissionDecision, "allow");
      assert.deepEqual(ok.hookSpecificOutput?.updatedInput, { command: "echo safe" });
      for (const [tool, tag] of [["Bash", "escape"], ["Read", "read-out"], ["Bash", "abs"]]) {
        const input = tool === "Read" ? { file_path: path.join(w.agentDir, "outputs/a.md"), tag } : { command: "ls", tag };
        const d = await f.pre(tool, input);
        assert.equal(d.hookSpecificOutput?.permissionDecision, "deny", `${tool} ${tag}`);
        assert.match(d.hookSpecificOutput!.permissionDecisionReason!, /^the rewritten call: /);
      }
    });
    assert.ok(events.some((e) => /^hook rewrite rewrote Bash: rewritten$/.test(e.text)));
  } finally { w.done(); }
});

test("a rewrite cannot reach a tool the agent was not granted, nor swap a delegation's sub-agent", async () => {
  const w = workspace();
  try {
    hook(w.ws, "swap", "on: tool.call", `
let s = ""; for await (const c of process.stdin) s += c;
const e = JSON.parse(s);
console.log(JSON.stringify({ input: { ...e.tool.input, subagent_type: "general-purpose" } }));
`);
    await step(w, ["swap"], async (f) => {
      const d = await f.pre("Agent", { subagent_type: "researcher", prompt: "go" });
      assert.equal(d.hookSpecificOutput?.permissionDecision, "deny");
      assert.match(d.hookSpecificOutput!.permissionDecisionReason!, /general-purpose" is not a sub-agent this step declared/);
      const g = await f.pre("WebFetch", { url: "https://x" });
      assert.equal(g.hookSpecificOutput?.permissionDecisionReason, "Tool WebFetch is not enabled for this agent.");
    }, {
      allowed: ["Agent", "Read"],
      subagents: [{ name: "researcher", description: "reads", prompt: "r", tools: ["Read"], disallowedTools: [], model: "inherit" }],
    });
  } finally { w.done(); }
});

test("a call a hook denies gives its limit back", async () => {
  const w = workspace();
  try {
    hook(w.ws, "no-rm", "on: tool.call\ntool: Bash", DENY_RM);
    await step(w, ["no-rm"], async (f) => {
      for (let i = 0; i < 3; i++) assert.equal((await f.pre("Bash", { command: "rm x" })).hookSpecificOutput?.permissionDecisionReason, "hook no-rm: no rm in this desk");
      // Two allowed calls still fit under a limit of 2: the denials counted nothing.
      assert.deepEqual(await f.pre("Bash", { command: "ls" }), {});
      assert.deepEqual(await f.pre("Bash", { command: "ls" }), {});
      assert.match((await f.pre("Bash", { command: "ls" })).hookSpecificOutput!.permissionDecisionReason!, /^limit reached/);
    }, { limits: { calls: 2 } });
  } finally { w.done(); }
});

// ------------------------------------------------------------------ (d)

test("a tool.result hook sees the tool's result, and a failing one does not stop the step", async () => {
  const w = workspace();
  try {
    hook(w.ws, "watch", "on: tool.result\ntool: Bash", `
import fs from "node:fs";
let s = ""; for await (const c of process.stdin) s += c;
fs.writeFileSync("seen.json", s);
console.log(JSON.stringify({ note: "saw it" }));
`);
    hook(w.ws, "crash", "on: tool.result", `throw new Error("nope")`);
    const { out, events } = await step(w, ["watch", "crash"], async (f) => {
      await f.post("Bash", { command: "ls" }, { stdout: "hello.txt", stderr: "" });
    });
    assert.equal(out.status, "completed");
    const seen = JSON.parse(fs.readFileSync(path.join(w.agentDir, "seen.json"), "utf8"));
    assert.equal(seen.event, "tool.result");
    assert.deepEqual(seen.tool, { name: "Bash", input: { command: "ls" } });
    assert.deepEqual(seen.result, { stdout: "hello.txt", stderr: "" });
    assert.ok(events.some((e) => e.text === "hook watch Bash: saw it"));
    assert.ok(events.some((e) => e.type === "error" && /^hook crash failed on tool.result Bash/.test(e.text)));
  } finally { w.done(); }
});

// ------------------------------------------------------------------ (e)

test("the hook's process has no secrets in its env and runs in the agent's directory", async () => {
  const w = workspace();
  try {
    hook(w.ws, "envdump", "on: tool.call", `
import fs from "node:fs";
fs.writeFileSync("env.json", JSON.stringify({ keys: Object.keys(process.env), cwd: process.cwd() }));
`);
    await step(w, ["envdump"], async (f) => { await f.pre("Bash", { command: "ls" }); }, {
      env: { PATH: process.env.PATH, HOME: "/home/x", FOLDRUN_MODEL_KEY: "k1", ANTHROPIC_API_KEY: "k2", MY_SECRET: "k3", CLAUDE_CODE_OAUTH_TOKEN: "k4", NODE_OPTIONS: "--require /tmp/x.js" },
    });
    const got = JSON.parse(fs.readFileSync(path.join(w.agentDir, "env.json"), "utf8"));
    assert.equal(fs.realpathSync(got.cwd), w.agentDir);
    for (const k of ["FOLDRUN_MODEL_KEY", "ANTHROPIC_API_KEY", "MY_SECRET", "CLAUDE_CODE_OAUTH_TOKEN", "NODE_OPTIONS"]) {
      assert.ok(!got.keys.includes(k), `${k} must not reach a hook`);
    }
    assert.ok(got.keys.includes("FOLDRUN_HOOK"));
  } finally { w.done(); }
});

// ------------------------------------------------------------------ (f)

test("editing run.mjs after the step resolved its hooks changes nothing that runs", async () => {
  const w = workspace();
  try {
    const dir = hook(w.ws, "no-rm", "on: tool.call\ntool: Bash", DENY_RM);
    await step(w, ["no-rm"], async (f) => {
      // What an agent with Write could do mid-step.
      fs.writeFileSync(path.join(dir, "run.mjs"), `console.log("{}")`);
      const d = await f.pre("Bash", { command: "rm -rf outputs" });
      assert.equal(d.hookSpecificOutput?.permissionDecision, "deny");
    });
  } finally { w.done(); }
});

// ------------------------------------------------------------------ (g)

test("step.start context reaches the prompt; step.end rewrites the reply", async () => {
  const w = workspace();
  try {
    hook(w.ws, "ctx", "on: step.start", `console.log("starting…"); console.log(JSON.stringify({ context: "Today is a holiday." }));`);
    hook(w.ws, "tidy", "on: step.end", `
let s = ""; for await (const c of process.stdin) s += c;
console.log(JSON.stringify({ reply: "TIDIED: " + JSON.parse(s).reply }));
`);
    let prompt = "";
    const { out } = await step(w, ["ctx", "tidy"], async (f) => { prompt = f.prompt; });
    assert.equal(prompt, "do the task\n\nToday is a holiday.");
    assert.equal(out.status, "completed");
    assert.equal(out.result, "TIDIED: the model's answer");
    assert.equal(out.conclusion, "TIDIED: the model's answer");
  } finally { w.done(); }
});

test("a step.start hook that fails, or exits 2, refuses the step before the model runs", async () => {
  const w = workspace();
  try {
    hook(w.ws, "gate-crash", "on: step.start", `throw new Error("x")`);
    hook(w.ws, "gate-no", "on: step.start", `process.stderr.write("not on weekends"); process.exit(2);`);
    for (const name of ["gate-crash", "gate-no"]) {
      let ran = false;
      const { out, events } = await step(w, [name], async () => { ran = true; });
      assert.equal(out.status, "failed", name);
      assert.equal(ran, false, `${name}: the model never ran`);
      if (name === "gate-no") assert.ok(events.some((e) => /not on weekends, so the step is refused/.test(e.text)));
    }
  } finally { w.done(); }
});

test("a hook named but missing refuses the step", async () => {
  const w = workspace();
  try {
    const { out, events } = await step(w, ["ghost"], async () => {});
    assert.equal(out.status, "failed");
    assert.ok(events.some((e) => /no hook named ghost/.test(e.text)));
  } finally { w.done(); }
});

// ------------------------------------------------------------------ (h)

test("parseAnswer: shapes", () => {
  assert.deepEqual(parseAnswer("tool.call", ""), { ok: true, decision: "allow" });
  assert.deepEqual(parseAnswer("tool.call", "log line\nmore noise\n{\"decision\":\"deny\",\"reason\":\"r\"}\n"), { ok: true, decision: "deny", reason: "r" });
  assert.match(parseAnswer("tool.call", "{\"decision\":\"allow\"}\ntrailing noise").failure!, /last line of output is not JSON/);
  assert.match(parseAnswer("tool.call", "[1,2]").failure!, /other than a JSON object/);
  assert.match(parseAnswer("tool.call", "null").failure!, /other than a JSON object/);
  assert.match(parseAnswer("tool.call", "{\"decision\":\"maybe\"}").failure!, /decision must be allow or deny/);
  assert.match(parseAnswer("tool.call", "{\"decision\":\"deny\"}").failure!, /a deny needs a reason/);
  assert.match(parseAnswer("tool.call", "{\"decision\":\"deny\",\"reason\":5}").failure!, /reason must be text/);
  assert.match(parseAnswer("tool.call", "{\"input\":[1]}").failure!, /input must be the tool's whole input/);
  assert.match(parseAnswer("tool.call", "{\"input\":\"ls\"}").failure!, /input must be/);
  assert.match(parseAnswer("tool.result", "{\"note\":3}").failure!, /note must be text/);
  assert.match(parseAnswer("step.start", "{\"context\":{}}").failure!, /context must be text/);
  assert.match(parseAnswer("step.end", "{\"reply\":1}").failure!, /reply must be text/);
  assert.deepEqual(parseAnswer("step.end", "{\"reply\":\"\"}"), { ok: true, reply: "" });
  assert.deepEqual(parseAnswer("tool.call", "{\"input\":{\"command\":\"ls\"},\"note\":\"n\"}"), { ok: true, decision: "allow", input: { command: "ls" }, note: "n" });
});

test("runHook: noise before the answer, a megabyte of it, and a split multibyte character", async () => {
  const w = workspace();
  try {
    const def = (code: string): HookDef => ({ name: "h", dir: w.ws, scope: "workspace", on: "tool.call", timeoutSec: 10, code });
    const big = await runHook(def(`process.stdout.write("x".repeat(2_000_000) + "\\n"); console.log(JSON.stringify({ decision: "deny", reason: "big" }));`), {}, { cwd: w.agentDir, env: {} });
    assert.equal(big.ok, true, big.failure);
    assert.equal(big.reason, "big");
    const utf = await runHook(def(`
const b = Buffer.from(JSON.stringify({ decision: "deny", reason: "café ☕" }) + "\\n");
const i = b.indexOf(0xe2) + 1; // inside ☕
process.stdout.write(b.subarray(0, i)); setTimeout(() => process.stdout.write(b.subarray(i)), 50);
`), {}, { cwd: w.agentDir, env: {} });
    assert.equal(utf.reason, "café ☕");
  } finally { w.done(); }
});

test("runToolCallHooks: first deny wins and rewrites chain in order", async () => {
  const mk = (name: string, tool?: string): HookDef => ({ name, dir: "/", scope: "workspace", on: "tool.call", timeoutSec: 1, code: "", ...(tool ? { tool } : {}) });
  const calls: string[] = [];
  const v = await runToolCallHooks([mk("a"), mk("skip", "Write"), mk("b"), mk("c")], { tool: "Bash", input: { command: "1" }, base: {} }, async (h, e) => {
    calls.push(`${h.name}:${(e.tool as { input: { command: string } }).input.command}`);
    if (h.name === "a") return { ok: true, decision: "allow", input: { command: "2" }, ms: 0 };
    if (h.name === "b") return { ok: true, decision: "deny", reason: "no", ms: 0 };
    return { ok: true, decision: "allow", ms: 0 };
  });
  assert.deepEqual(calls, ["a:1", "b:2"]);
  assert.equal(v.decision, "deny");
  assert.equal(v.reason, "hook b: no");
  assert.ok(v.records.every(isHookRecord));
});

// ------------------------------------------------------------------ (i)

test("matchesTool", () => {
  assert.equal(matchesTool(undefined, "Bash"), true);
  assert.equal(matchesTool("Bash", "Bash"), true);
  assert.equal(matchesTool("Bash", "BashOutput"), false);
  assert.equal(matchesTool("Write|Edit", "Edit"), true);
  assert.equal(matchesTool("Write | Edit", "Write"), true);
  assert.equal(matchesTool("Write|Edit", "Read"), false);
  assert.equal(matchesTool("mcp__*", "mcp__crm__lookup"), true);
  assert.equal(matchesTool("mcp__*", "Bash"), false);
  assert.equal(matchesTool("mcp__crm__*", "mcp__other__lookup"), false);
  assert.equal(matchesTool("web", "mcp__foldrun_scripts__web"), true);
  assert.equal(matchesTool("web", "WebFetch"), false);
  assert.equal(matchesTool("mcp__foldrun_scripts__web", "mcp__foldrun_scripts__web"), true);
  assert.equal(matchesTool("mcp__x__web", "mcp__foldrun_scripts__web"), false, "a full name is not matched by its short half");
  assert.equal(matchesTool("*", "anything"), true);
  // Regex characters are literal: `.` is not "any character", `(` does not throw.
  assert.equal(matchesTool("a.b", "axb"), false);
  assert.equal(matchesTool("a.b", "a.b"), true);
  assert.equal(matchesTool("x(y", "x(y"), true);
  assert.equal(matchesTool("|", "Bash"), false, "an empty pattern list matches nothing");
});

// ------------------------------------------------------------- definitions

test("readHookDef / resolveHooks / checkHooksDir", () => {
  const w = workspace();
  try {
    hook(w.ws, "good", "on: tool.call\ntool: Bash\ntimeout: 5", "console.log('{}')");
    hook(w.ws, "bad-on", "on: run.end", "");
    hook(w.ws, "bad-tool", "on: step.end\ntool: Bash", "");
    hook(w.ws, "bad-timeout", "on: tool.call\ntimeout: 999", "");
    const lib = path.join(w.ws, "lib");
    hook(lib, "shared", "on: step.end", "");
    const g = readHookDef(path.join(w.ws, "hooks", "good"), "workspace");
    assert.ok(!("error" in g));
    assert.equal((g as HookDef).timeoutSec, 5);
    assert.equal((g as HookDef).code, "console.log('{}')");
    const r = resolveHooks({ workspaceRoot: w.ws, libraryRoot: lib, names: ["good", "shared", "good", "nope", "bad-on"] });
    assert.deepEqual(r.hooks.map((h) => `${h.name}:${h.scope}`), ["good:workspace", "shared:account"]);
    assert.deepEqual(r.missing, ["nope"]);
    assert.match(r.errors[0], /run.end is not available yet/);
    const problems = checkHooksDir(path.join(w.ws, "hooks"), "workspace");
    assert.equal(problems.length, 3);
    assert.ok(problems.some((p) => /tool: only means something/.test(p)));
    assert.ok(problems.some((p) => /timeout: is seconds/.test(p)));
  } finally { w.done(); }
});
