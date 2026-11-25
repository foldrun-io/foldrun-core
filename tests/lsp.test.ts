// The language-server layer and Symbols (FOL-297). A stand-in server, placed
// where a pinned one is installed, answers offline; FOLDRUN_LSP_REAL=1 also
// installs and asks the real TypeScript, Python and Go servers.
//
//   node --test tests/lsp.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENGINE_TOOLS, killGroups, type ToolContext } from "../src/engine-tools.ts";
import { columnOf, languageOf, PINNED, stopServers } from "../src/lsp.ts";

const { Symbols } = ENGINE_TOOLS;

function withDir(body: (dir: string, ctx: ToolContext, tools: string) => Promise<void>, o: Partial<ToolContext> = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-lsp-")));
  const tools = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-lsp-tools-")));
  const stop = new AbortController();
  const ctx: ToolContext = { cwd: dir, env: { PATH: process.env.PATH, HOME: os.homedir() }, signal: stop.signal, reads: new Map(), groups: new Set(), programs: true, toolsDir: tools, ...o };
  return body(dir, ctx, tools).finally(() => {
    stopServers(ctx);
    killGroups(ctx);
    fs.rmSync(dir, { recursive: true, force: true });
    // Go keeps its module cache read-only: made writable before it is removed.
    const writable = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) {
          fs.chmodSync(f, 0o755);
          writable(f);
        }
      }
    };
    try {
      writable(tools);
    } catch {
      /* nothing there */
    }
    fs.rmSync(tools, { recursive: true, force: true });
  });
}

/** A stand-in for the pinned TypeScript server: definition → a.ts line 1; references → a.ts, b.ts and a file outside. */
function fakeServer(tools: string, dir: string, outside: string) {
  const bin = path.join(tools, `typescript-${PINNED.typescript}`, "node_modules", ".bin");
  fs.mkdirSync(bin, { recursive: true });
  const a = new URL(`file://${path.join(dir, "a.ts")}`).href;
  const b = new URL(`file://${path.join(dir, "b.ts")}`).href;
  const o = new URL(`file://${outside}`).href;
  fs.writeFileSync(path.join(bin, "tsc"), `#!/usr/bin/env node
let buf = Buffer.alloc(0);
const send = (m) => { const s = JSON.stringify(m); process.stdout.write("Content-Length: " + Buffer.byteLength(s) + "\\r\\n\\r\\n" + s); };
const loc = (uri, line, character) => ({ uri, range: { start: { line, character }, end: { line, character: character + 3 } } });
let opened = 0;
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const h = buf.indexOf("\\r\\n\\r\\n"); if (h < 0) return;
    const n = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, h).toString())[1]);
    if (buf.length < h + 4 + n) return;
    const m = JSON.parse(buf.subarray(h + 4, h + 4 + n).toString()); buf = buf.subarray(h + 4 + n);
    if (m.method === "textDocument/didOpen") opened++;
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { capabilities: { definitionProvider: true, referencesProvider: true }, args: process.argv.slice(2) } });
    else if (m.method === "textDocument/definition") send({ jsonrpc: "2.0", id: m.id, result: opened ? [loc(${JSON.stringify(a)}, 0, 16)] : [] });
    else if (m.method === "textDocument/references") send({ jsonrpc: "2.0", id: m.id, result: [loc(${JSON.stringify(a)}, 0, 16), loc(${JSON.stringify(b)}, 1, m.params.position.character), loc(${JSON.stringify(o)}, 0, 0)] });
    else if (m.id !== undefined && !m.method) {}
    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: null });
  }
});
`, { mode: 0o755 });
}

test("columnOf: the name's column on the line, whole words first, the nearest when given", () => {
  assert.equal(columnOf("const addAll = add(1) + add(2);", "add"), 15);
  assert.equal(columnOf("const addAll = add(1) + add(2);", "add", 24), 24);
  assert.equal(columnOf("x.addAll()", "add"), 2, "inside a word only when no whole word is there");
  assert.equal(columnOf("nothing here", "add"), null);
  assert.equal(languageOf("x.tsx"), "typescript");
  assert.equal(languageOf("x.py"), "python");
  assert.equal(languageOf("x.go"), "go");
  assert.equal(languageOf("x.rs"), null);
});

test("Symbols: definition and references from the server, each location checked before it is shown (FOL-297)", () =>
  withDir(async (dir, ctx, tools) => {
    const outside = path.join(fs.realpathSync(os.tmpdir()), `foldrun-lsp-outside-${process.pid}.ts`);
    fs.writeFileSync(outside, "secret line\n");
    try {
      fs.writeFileSync(path.join(dir, "a.ts"), "export function add(a: number, b: number) { return a + b; }\n");
      fs.writeFileSync(path.join(dir, "b.ts"), 'import { add } from "./a";\nconsole.log(add(1, 2));\n');
      fakeServer(tools, dir, outside);
      ctx.readable = (f) => !path.relative(dir, f).startsWith("..");
      const def = await Symbols.run({ action: "definition", file_path: "b.ts", line: 2, symbol: "add" }, ctx);
      assert.equal(def.isError, undefined, def.text);
      assert.match(def.text, /^definition of add at b\.ts:2:13:\na\.ts:1:17  export function add/);
      const refs = await Symbols.run({ action: "references", file_path: "b.ts", line: 2, symbol: "add" }, ctx);
      assert.match(refs.text, /^2 references of add at b\.ts:2:13:\na\.ts:1:17 .*\nb\.ts:2:13  console\.log\(add\(1, 2\)\);\n\(1 more in files this session may not read\)$/);
      assert.doesNotMatch(refs.text, /secret line|foldrun-lsp-outside/, "a location the client's rule refuses is neither named nor read");
    } finally {
      fs.rmSync(outside, { force: true });
    }
  }));

test("Symbols: refused where programs are not run unasked, for an unknown language, and with no name on the line", () =>
  withDir(async (dir, ctx) => {
    fs.writeFileSync(path.join(dir, "a.ts"), "export const x = 1;\n");
    fs.writeFileSync(path.join(dir, "a.rs"), "fn main() {}\n");
    assert.match((await Symbols.run({ action: "definition", file_path: "a.ts", line: 1, symbol: "x" }, { ...ctx, programs: false })).text, /runs only inside the sandbox/);
    assert.match((await Symbols.run({ action: "definition", file_path: "a.rs", line: 1, symbol: "main" }, ctx)).text, /Symbols reads TypeScript, JavaScript, Python and Go/);
    assert.match((await Symbols.run({ action: "definition", file_path: "a.ts", line: 1, symbol: "nope" }, ctx)).text, /"nope" is not on line 1/);
    assert.match((await Symbols.run({ action: "definition", file_path: "a.ts", line: 9, symbol: "x" }, ctx)).text, /has 2 lines/);
    assert.match((await Symbols.run({ action: "rename", file_path: "a.ts", line: 1, symbol: "x" }, ctx)).text, /definition or references/);
    assert.match((await Symbols.run({ action: "definition", file_path: "a.ts", line: 1 }, ctx)).text, /give symbol/);
    assert.match((await Symbols.run({ action: "definition", file_path: "a.ts", line: 1, symbol: "x" }, { ...ctx, toolsDir: undefined })).text, /no place to install/);
    assert.match((await Symbols.run({ action: "definition", file_path: "a.ts", line: 1, symbol: "x" }, { ...ctx, readable: () => false })).text, /not a file this session may read/);
  }));

test("Symbols with the real servers: TypeScript, Python, Go installed on first use (FOLDRUN_LSP_REAL=1)", { skip: process.env.FOLDRUN_LSP_REAL === "1" ? false : "set FOLDRUN_LSP_REAL=1", timeout: 600_000 }, () =>
  withDir(async (dir, ctx, tools) => {
    if (process.env.FOLDRUN_LSP_TOOLS) ctx.toolsDir = process.env.FOLDRUN_LSP_TOOLS;
    void tools;
    fs.writeFileSync(path.join(dir, "a.ts"), "export function add(a: number, b: number) { return a + b; }\n");
    fs.writeFileSync(path.join(dir, "b.ts"), 'import { add } from "./a";\nconsole.log(add(1, 2));\nadd(3, 4);\n');
    const ts = await Symbols.run({ action: "references", file_path: "b.ts", line: 3, symbol: "add" }, ctx);
    assert.match(ts.text, /4 references of add[\s\S]*a\.ts:1:17[\s\S]*b\.ts:1:10[\s\S]*b\.ts:2:13[\s\S]*b\.ts:3:1/, ts.text);
    fs.writeFileSync(path.join(dir, "m.py"), "def add(a, b):\n    return a + b\n");
    fs.writeFileSync(path.join(dir, "n.py"), "from m import add\nprint(add(1, 2))\n");
    const py = await Symbols.run({ action: "definition", file_path: "n.py", line: 2, symbol: "add" }, ctx);
    assert.match(py.text, /definition of add[\s\S]*m\.py:1:5  def add/, py.text);
    if (languageOf("x.go") && process.env.FOLDRUN_LSP_GO !== "0") {
      fs.writeFileSync(path.join(dir, "go.mod"), "module demo\n\ngo 1.22\n");
      fs.writeFileSync(path.join(dir, "main.go"), "package main\n\nfunc Add(a, b int) int { return a + b }\n\nfunc main() { println(Add(1, 2)) }\n");
      const go = await Symbols.run({ action: "definition", file_path: "main.go", line: 5, symbol: "Add" }, ctx);
      assert.match(go.text, /definition of Add[\s\S]*main\.go:3:6  func Add/, go.text);
    }
  }));
