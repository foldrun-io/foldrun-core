// tools: [symbols] in a step (FOL-297): the step's own tool, confined to what the file tools may read.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSymbolsTools, SYMBOLS_TOOL } from "../src/symbols-tool.ts";

test("symbols in a step: refuses files outside the workspace and the secrets, reads workspace/… paths", async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-sym-ws-")));
  const agentDir = path.join(ws, "agents", "coder");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(ws, "a.rs"), "fn main() {}\n");
  const t = buildSymbolsTools({ agentDir, workspaceRoot: ws, libraryRoot: path.join(ws, "lib"), toolsDir: path.join(ws, ".tools") });
  try {
    assert.equal(SYMBOLS_TOOL, "mcp__foldrun_symbols__symbols");
    const out = (await t.call({ action: "definition", file_path: "/etc/passwd", line: 1, symbol: "root" })) as any;
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /symbols was refused|may not be read/);
    const lang = (await t.call({ action: "definition", file_path: "workspace/a.rs", line: 1, symbol: "main" })) as any;
    assert.match(lang.content[0].text, /TypeScript, JavaScript, Python and Go/, "a workspace/… path reaches the file");
  } finally {
    t.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
