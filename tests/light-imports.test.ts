// FOL-265: a turn of `foldrun code` must not pay for what it does not use.
// The engine loop loads the MCP library only when a step has a server, and
// the model and effort words come without the rest of core. Each module is
// imported in a fresh process and what it loaded is listed.
//
//   node --test tests/light-imports.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

/** A file URL, not a path: a `#` in a checkout path or a Windows drive letter would break import() of a path (Codex). */
const src = (f: string) => new URL(`../src/${f}`, import.meta.url).href;

/** Every module URL a fresh process loads when it imports `file`. */
function loads(file: string): string[] {
  const script = `
    import { registerHooks } from "node:module";
    const seen = [];
    registerHooks({ resolve(s, c, next) { const r = next(s, c); seen.push(r.url); return r; } });
    await import(${JSON.stringify(file)});
    process.stdout.write(JSON.stringify(seen));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
}

for (const f of ["engine-loop.ts", "engine-common.ts", "mcp-specs.ts"]) {
  test(`${f} does not load the MCP library — only connecting a server does`, () => {
    const got = loads(src(f));
    assert.ok(got.length > 0);
    assert.deepEqual(got.filter((u) => /@modelcontextprotocol\/sdk|\/engine-mcp\.ts$/.test(u)), []);
  });
}

test("model-names.ts brings resolveTier and resolveEffort without the rest of core", async () => {
  const got = loads(src("model-names.ts")).filter((u) => u.startsWith("file:"));
  assert.deepEqual(got.map((u) => u.split("/src/").pop()).sort(), ["frontmatter-fields.ts", "model-names.ts"]);
  const m = await import("../src/model-names.ts");
  assert.equal(m.resolveTier("small"), "fast");
  assert.equal(m.resolveEffort("default"), "high");
  const store = await import("../src/store.ts");
  assert.equal(store.resolveTier, m.resolveTier, "store.ts still exports the same functions");
  assert.equal(store.resolveEffort, m.resolveEffort);
});

test("engine-mcp.ts still exports the helpers it did", async () => {
  const m = await import("../src/engine-mcp.ts");
  for (const k of ["grantedServer", "checkMcpSpecs", "ENGINE_MCP_FEATURES", "connectMcp", "outcomeOf", "shellLine"]) assert.ok(k in m, k);
});
