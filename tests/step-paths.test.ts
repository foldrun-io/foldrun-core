// A read of `workspace/storage/x` reaches the workspace, not a stray copy.
//
// canUseTool is never asked about a read inside the cwd, so the prefix
// rewrite there did nothing for Read, Glob or Grep: on 2026-09-24 a read of
// `workspace/storage/probe.txt` returned a stale copy from
// `<agentDir>/workspace/storage/`, with no error. The PreToolUse hook runs on
// every call; these cases hold it to that.
//
//   node --test tests/step-paths.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeStep, type QueryFn } from "../src/step-exec.ts";

test("the PreToolUse hook rewrites workspace/ for reads and refuses an escape", async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paths-ws-")));
  const agentDir = path.join(ws, "agents", "a");
  fs.mkdirSync(agentDir, { recursive: true });
  let hook: ((i: unknown, id: string | undefined, o: { signal: AbortSignal }) => Promise<any>) | null = null;
  const query: QueryFn = ({ options }) => {
    hook = (options as any).hooks.PreToolUse[0].hooks[0];
    const stream = (async function* () {
      yield { type: "result", subtype: "success", result: "done", total_cost_usd: 0 };
    })();
    return Object.assign(stream, { async interrupt() {} });
  };
  await executeStep({
    agentDir, workspaceRoot: ws, libraryRoot: path.join(ws, "..", "lib"), prompt: "p", model: "haiku", systemPrompt: "s",
    allowed: ["Read"], mcpNames: [], mcpServers: {}, env: {}, emit: () => {},
  } as any, query);
  assert.ok(hook, "executeStep registers a PreToolUse hook");
  const call = (tool: string, file_path: string) =>
    hook!({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { file_path } }, "t", { signal: new AbortController().signal });

  // As the SDK sends it: already absolute, under the agent's folder.
  const r = await call("Read", path.join(agentDir, "workspace/storage/probe.txt"));
  assert.equal(r.hookSpecificOutput?.updatedInput?.file_path, path.join(ws, "storage/probe.txt"));
  // A plain path is left to the normal flow.
  assert.deepEqual(await call("Read", path.join(agentDir, "outputs/x.md")), {});
  // An escape is refused here too, not only in canUseTool.
  const esc = await call("Read", "/etc/passwd");
  assert.equal(esc.hookSpecificOutput?.permissionDecision, "deny");
  // Non-filesystem tools pass through untouched.
  assert.deepEqual(await hook!({ hook_event_name: "PreToolUse", tool_name: "WebSearch", tool_input: {} }, "t", { signal: new AbortController().signal }), {});
});
