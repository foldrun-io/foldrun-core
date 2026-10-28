// gray-matter eval()s `---js` frontmatter by default. Every markdown file is
// tenant-written and parsed on the shared web pod and worker, so only YAML
// may be a frontmatter language (29 Oct 2026, OWASP review).
import { test } from "node:test";
import assert from "node:assert/strict";
import matter, { configMatter } from "../src/matter.ts";

for (const lang of ["js", "javascript", "coffee"]) {
  test(`---${lang} frontmatter is refused, never run`, () => {
    const g = globalThis as { __fmRan?: boolean };
    delete g.__fmRan;
    const src = `---${lang}\n{a: (globalThis.__fmRan = true)}\n---\nbody`;
    assert.throws(() => matter(src), /only YAML/);
    assert.throws(() => configMatter(src), /only YAML/);
    assert.equal(g.__fmRan, undefined);
  });
}

test("YAML frontmatter still reads", () => {
  assert.deepEqual(matter("---\nname: x\n---\nhi").data, { name: "x" });
  assert.equal(configMatter("---\nname: y\n---\n").data.name, "y");
});
