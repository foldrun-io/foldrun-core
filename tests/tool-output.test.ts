// A long tool result is kept in a file and previewed, not cut and lost.
//
//   node --test tests/tool-output.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { previewOrKeep, canReadBack, RESULT_PREVIEW_CHARS, RESULTS_DIR, UNREADABLE_CAP } from "../src/tool-output.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-tool-output-"));
/** An agent that holds Read or Grep, and one that does not. */
const reads = (dir: string) => ({ dir, readable: () => true });
const blind = (dir: string) => ({ dir, readable: () => false });

test("a short result passes through untouched, and nothing is written", () => {
  const dir = tmp();
  assert.equal(previewOrKeep("short", reads(dir), "x"), "short");
  assert.equal(fs.existsSync(path.join(dir, RESULTS_DIR)), false);
});

test("a long result: the head inline, the whole of it in a file the agent can Read", () => {
  const dir = tmp();
  const text = Array.from({ length: 2000 }, (_, i) => `row ${i} ${"x".repeat(40)}`).join("\n");
  const shown = previewOrKeep(text, reads(dir), "web search");
  // Cut at a line break, never mid-row, and well under the whole.
  const head = shown.slice(0, shown.indexOf("\n…("));
  assert.ok(head.length <= RESULT_PREVIEW_CHARS && head.length > RESULT_PREVIEW_CHARS * 0.8, String(head.length));
  assert.ok(text.startsWith(head) && text[head.length] === "\n", "cut at a line break");
  const rel = /`(\.cache\/results\/[^`]+)`/.exec(shown)?.[1];
  assert.ok(rel, shown.slice(-300));
  assert.match(rel!, /^\.cache\/results\/web_search-/, "named after the tool, safely");
  assert.equal(fs.readFileSync(path.join(dir, rel!), "utf8"), text, "the file holds all of it");
  assert.match(shown, new RegExp(`${text.length - head.length} more characters not shown`));
  assert.match(shown, /Read it with offset\/limit, or Grep it/);
});

test("an agent that cannot read files back gets the whole result up to the old cut, and no file", () => {
  const dir = tmp();
  // 15k: over the preview, under the old cut — it arrives whole, as before.
  const mid = "z".repeat(15_000);
  assert.equal(previewOrKeep(mid, blind(dir), "x"), mid);
  assert.equal(previewOrKeep(mid, null, "x"), mid);
  // Past the old cut: cut there, as it always was.
  const long = previewOrKeep("y".repeat(30_000), blind(dir), "x");
  assert.equal(long, `${"y".repeat(UNREADABLE_CAP)}\n…[truncated]`);
  assert.equal(fs.existsSync(path.join(dir, RESULTS_DIR)), false, "nothing kept where the agent cannot go");
});

test("Read or Grep in the grants is what lets a result be read back", () => {
  assert.equal(canReadBack(["Read", "Write"]), true);
  assert.equal(canReadBack(["Grep"]), true);
  assert.equal(canReadBack(["mcp__foldrun_apis__call_crm", "mcp__foldrun_scripts__web"]), false);
  assert.equal(canReadBack([]), false);
});

test("a script tool previews a long output and keeps the rest; a short one is as it was", async () => {
  const { parseToolDef } = await import("../src/store.ts");
  const { parseScripts, buildScriptTools } = await import("../src/script-tools.ts");
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "big.mjs"), `process.stdout.write("line\\n".repeat(10000));`);
  fs.writeFileSync(path.join(dir, "small.mjs"), `console.log("hi");`);
  const specs = parseScripts([
    parseToolDef({ transport: "script", name: "big", description: "prints a lot", run: "big.mjs" }, "big", "")!.spec,
    parseToolDef({ transport: "script", name: "small", description: "prints a little", run: "small.mjs" }, "small", "")!.spec,
  ]);
  const built = buildScriptTools(dir, specs, {}, "", {}, null, () => true);
  type Reply = { content: { text: string }[] };
  const tools = (built.server as unknown as { instance: { _registeredTools: Record<string, { handler: (a: object, e: object) => Promise<Reply> }> } }).instance._registeredTools;
  const big = (await tools.big.handler({}, {})).content[0].text;
  assert.match(big, /^exit 0\n\n/);
  assert.ok(big.length < RESULT_PREVIEW_CHARS + 500, `inline ${big.length}`);
  const rel = /`(\.cache\/results\/[^`]+)`/.exec(big)![1];
  assert.equal(fs.readFileSync(path.join(dir, rel), "utf8").length, "line\n".repeat(10000).length, "nothing lost past the old 20,000-character cut");
  assert.equal((await tools.small.handler({}, {})).content[0].text, "exit 0\n\nhi\n");
  // A scripts-only agent (no read tool): the default, the old behaviour.
  const blindBuilt = buildScriptTools(dir, specs, {});
  const blindTools = (blindBuilt.server as unknown as { instance: { _registeredTools: Record<string, { handler: (a: object, e: object) => Promise<Reply> }> } }).instance._registeredTools;
  const whole = (await blindTools.big.handler({}, {})).content[0].text;
  assert.doesNotMatch(whole, /\.cache\/results/);
  assert.match(whole, /…\[truncated\]$/, "past 20,000 it is cut as before");
});

test("an API tool previews a long body and keeps all of it", async () => {
  const http = await import("node:http");
  const { buildApiTools } = await import("../src/api-tools.ts");
  const body = JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ id: i, name: `contact ${i}` })), null, 1);
  const server = http.createServer((_req, res) => res.end(body));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const dir = tmp();
    const built = buildApiTools("t", [{ name: "crm", base: `http://127.0.0.1:${port}`, description: "", headers: {}, query: {}, methods: ["GET"] }], undefined, { env: {}, missing: [] }, reads(dir));
    type Reply = { content: { text: string }[] };
    const tools = (built.server as unknown as { instance: { _registeredTools: Record<string, { handler: (a: object, e: object) => Promise<Reply> }> } }).instance._registeredTools;
    const text = (await tools.call_crm.handler({ method: "GET", path: "/contacts" }, {})).content[0].text;
    assert.match(text, /^HTTP 200/);
    assert.ok(text.length < RESULT_PREVIEW_CHARS + 500, `inline ${text.length}`);
    const rel = /`(\.cache\/results\/crm-get-[^`]+)`/.exec(text)![1];
    assert.equal(fs.readFileSync(path.join(dir, rel), "utf8"), body, "the whole body, past the old 20,000-character cut");

    // The same API granted alone — `apis:` with no read tool — gets the body
    // as before: whole up to 20,000 characters, never a path it cannot open.
    const blindDir = tmp();
    const alone = buildApiTools("t", [{ name: "crm", base: `http://127.0.0.1:${port}`, description: "", headers: {}, query: {}, methods: ["GET"] }], undefined, { env: {}, missing: [] }, blind(blindDir));
    const aloneTools = (alone.server as unknown as { instance: { _registeredTools: Record<string, { handler: (a: object, e: object) => Promise<Reply> }> } }).instance._registeredTools;
    const seen = (await aloneTools.call_crm.handler({ method: "GET", path: "/contacts" }, {})).content[0].text;
    assert.doesNotMatch(seen, /\.cache\/results/);
    assert.ok(seen.includes(body.slice(0, UNREADABLE_CAP)), "the first 20,000 characters, as before");
    assert.equal(fs.existsSync(path.join(blindDir, RESULTS_DIR)), false);
  } finally {
    server.close();
  }
});
