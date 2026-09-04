// Built-in tools gallery: listing, and assignment to account or workspace.
//
//   node --test tests/gallery.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { GALLERY, galleryTemplate, installGalleryTool } from "../packages/core/src/gallery.ts";
import { readLibraryFile } from "../packages/core/src/library.ts";
import { parseToolDef, readWorkspaceFile, saveWorkspace, workspaceTools, writeWorkspaceFile } from "../packages/core/src/store.ts";
import { missingToolPrograms } from "../packages/core/src/tool-programs.ts";
import { isEditablePath, listWorkspaceFiles } from "../packages/core/src/store.ts";
import { SCRIPT_LANGUAGES, toolStarter } from "../packages/core/src/kinds.ts";
import { fencedCode } from "../packages/core/src/store.ts";

function withData(body: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gallery-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  try {
    body();
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("the browser ships as a folder: a definition, and the program beside it", () => {
  const browser = GALLERY.find((t) => t.name === "browser");
  assert.ok(browser, "browser tool exists");
  assert.equal(browser!.kind, "tools");
  assert.equal(browser!.file, "browser/tool.md");
  assert.equal(browser!.snippet, "tools: [browser]");
  assert.equal(browser!.wrapper?.file, "browser/run.mjs", "the program is a file");

  const { data, content } = matter(browser!.content);
  const def = parseToolDef(data as Record<string, unknown>, "browser", content);
  assert.equal(def!.kind, "script");
  const spec = def!.spec as { run?: string; code?: string };
  // Points at the file, carries no code — the shape every script tool takes.
  assert.equal(spec.run, "run.mjs");
  assert.equal(spec.code, undefined);
  assert.match(browser!.wrapper!.content, /chromium\.launch/);

  // And the definition's prose must not itself parse as a program: the body
  // keeps a ```yaml usage example, which no interpreter claims.
  assert.equal(fencedCode(content), null);
});

test("installing the browser writes both files at either scope", () =>
  withData(() => {
    assert.equal(installGalleryTool("acme", "browser"), "browser/tool.md");
    assert.match(readLibraryFile("acme", "tools", "browser/run.mjs"), /chromium\.launch/);

    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
    assert.equal(installGalleryTool("acme", "browser", "desk"), "tools/browser/tool.md");
    // Byte-identical at both scopes: nothing to rewrite, because a folder
    // tool's run: names the file beside it and never the scope it sits in.
    assert.equal(
      readWorkspaceFile("acme", "desk", "tools/browser/tool.md"),
      readLibraryFile("acme", "tools", "browser/tool.md"),
    );
    assert.equal(
      readWorkspaceFile("acme", "desk", "tools/browser/run.mjs"),
      readLibraryFile("acme", "tools", "browser/run.mjs"),
    );
  }));

test("an installed gallery script tool loads with its program on disk", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
    installGalleryTool("acme", "browser", "desk");
    const def = workspaceTools("acme", "desk").browser;
    assert.equal(def.kind, "script");
    assert.equal((def.spec as { run?: string }).run, "workspace/tools/browser/run.mjs");
    // The check `foldrun check` runs, applied to what the gallery installed.
    assert.deepEqual(missingToolPrograms("acme", "desk"), []);
  }));

test("an unknown tool is refused", () =>
  withData(() => {
    assert.throws(() => installGalleryTool("acme", "nope"), /no such gallery tool/);
  }));

// ------------------------------------------------------------- API tools

test("every API tool in the gallery parses into a working http tool", () => {
  // The http ones: everything on the tools shelf that isn't a folder tool
  // carrying its own code.
  // The http ones: a tool whose body carries a program is a script tool.
  // The http ones: a gallery entry with a program beside it is a script tool.
  for (const t of GALLERY.filter((t) => t.kind === "tools" && !t.wrapper)) {
    const { data } = matter(t.content);
    const def = parseToolDef(data as Record<string, unknown>, t.name);
    assert.ok(def, `${t.name} parses`);
    assert.equal(def!.kind, "http", `${t.name} is an http tool`);
    assert.ok((def!.spec as { base: string }).base.startsWith("https://"), `${t.name} is https`);
    assert.equal(t.snippet, `tools: [${t.name}]`, `${t.name} snippet is the grant`);
  }
});

test("stripe stays read-only however the definition is edited upstream", () => {
  const stripe = GALLERY.find((t) => t.name === "stripe")!;
  const { data } = matter(stripe.content);
  const def = parseToolDef(data as Record<string, unknown>, "stripe")!;
  assert.deepEqual((def.spec as { methods: string[] }).methods, ["GET"]);
});

test("an API tool installs onto the tools shelf, not scripts", () =>
  withData(() => {
    const rel = installGalleryTool("acme", "email");
    assert.equal(rel, "email.md");
    assert.match(readLibraryFile("acme", "tools", rel), /api\.resend\.com/);
    // And into a workspace's own tools dir when scoped there.
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
    assert.equal(installGalleryTool("acme", "slack", "desk"), "tools/slack.md");
    assert.match(readWorkspaceFile("acme", "desk", "tools/slack.md"), /chat\.postMessage/);
  }));

// -------------------------------------------------- start-from templates

test("starting from a gallery entry renames it everywhere the name appears", () => {
  const [seed] = galleryTemplate("tools", "email", "my-mailer")!;
  assert.equal(seed.file, "my-mailer.md");
  const { data } = matter(seed.content);
  assert.equal(data.name, "my-mailer");
  // The body's opt-in line would otherwise tell a reader to grant a tool
  // that does not exist under that name.
  assert.match(seed.content, /tools: \[my-mailer\]/);
  assert.doesNotMatch(seed.content, /\[email\]/);
  // Still a working definition, not just renamed text.
  assert.equal(parseToolDef(data as Record<string, unknown>, "my-mailer")!.kind, "http");
});

test("a wrong-kind template is refused, and an unknown one too", () => {
  // browser lives on the tools shelf now, so asking the scripts shelf for it
  // returns null — which callers treat exactly like "no template chosen".
  assert.equal(galleryTemplate("scripts", "browser", "x"), null);
  assert.equal(galleryTemplate("tools", "nope", "x"), null);
});

// Starting from a folder entry must seed the folder. Handing back only the
// definition would write a `run:` pointing at a file nobody created — the
// exact state `foldrun check` now reports as an error.
test("starting from a folder gallery entry seeds both of its files", () => {
  const seed = galleryTemplate("tools", "browser", "my-browser")!;
  assert.deepEqual(seed.map((f) => f.file), ["my-browser/tool.md", "my-browser/run.mjs"]);
  const { data } = matter(seed[0].content);
  assert.equal(data.name, "my-browser");
  // run: still names the file beside it — the folder was renamed, not the
  // program, and neither travels without the other.
  assert.equal(data.run, "run.mjs");
  assert.match(seed[0].content, /tools: \[my-browser\]/);
  assert.match(seed[1].content, /chromium\.launch/);
});

// --------------------------------------------------- creating a new tool

test("a new script tool is a folder: the definition, and the program beside it", () => {
  const files = toolStarter("my-thing", "script");
  assert.deepEqual(files.map((f) => f.file), [
    "tools/my-thing/tool.md",
    "tools/my-thing/run.mjs",
  ]);

  const { data, content } = matter(files[0].content);
  const def = parseToolDef(data as Record<string, unknown>, "my-thing", content);
  assert.equal(def!.kind, "script");
  const spec = def!.spec as { run?: string; code?: string };
  // The program is a file, so the definition points at it and carries no code.
  assert.equal(spec.run, "run.mjs");
  assert.equal(spec.code, undefined);

  // And it is a real program, not a snippet: it validates its own argument,
  // because every declared arg is optional at the call site.
  assert.match(files[1].content, /parseArgs/);
  assert.match(files[1].content, /process\.exit\(1\)/);
});

// The failure this guards: a body that opens with a usage example in a fence
// whose language tag happens to be executable. `run:` wins — the parser never
// looks at the body — but the starter should not be the file that teaches the
// habit, so its examples are tagged with something no interpreter claims.
test("the starter's own examples cannot be mistaken for the program", () => {
  const [manifest] = toolStarter("my-thing", "script");
  const { content } = matter(manifest.content);
  const fence = fencedCode(content);
  assert.equal(fence, null, `a fenced block in the starter parsed as code: ${fence?.ext}`);
});

test("an API or MCP tool is still one flat file", () => {
  for (const [transport, kind] of [["http", "http"], ["mcp", "mcp"]] as const) {
    const files = toolStarter("my-thing", transport);
    assert.equal(files.length, 1, `${transport} is one file`);
    assert.equal(files[0].file, "tools/my-thing.md");
    const def = parseToolDef(matter(files[0].content).data as Record<string, unknown>, "my-thing");
    assert.equal(def!.kind, kind);
  }
});

// Creating a script tool is one action that writes two files, and both have
// to land. The starter returning a manifest whose `run:` names a file nobody
// wrote is the exact failure `foldrun check` now reports — so the create flow
// must not be able to produce it.
test("creating a script tool writes the program its definition points at", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
    for (const f of toolStarter("my-thing", "script")) {
      writeWorkspaceFile("acme", "desk", f.file, f.content);
    }

    // It loads as a tool, under the name that was asked for.
    const def = workspaceTools("acme", "desk")["my-thing"];
    assert.ok(def, "the new tool did not load");
    assert.equal(def.kind, "script");

    // And its program is on disk where the definition says — the check that
    // `foldrun check` runs, applied to what "New tool" just produced.
    assert.deepEqual(missingToolPrograms("acme", "desk"), []);
  }));

// Three questions, and the third used to be answered silently: "script tool"
// meant JavaScript, which you found out by opening the file it wrote. The
// runner has always chosen an interpreter from the extension, so the choice
// was real and merely hidden.
test("a script tool is written in the language you picked", () => {
  const expected: Record<string, { program: string; marker: RegExp }> = {
    javascript: { program: "tools/x/run.mjs", marker: /parseArgs/ },
    python: { program: "tools/x/run.py", marker: /argparse/ },
    bash: { program: "tools/x/run.sh", marker: /#!\/usr\/bin\/env bash/ },
  };

  for (const lang of SCRIPT_LANGUAGES) {
    const files = toolStarter("x", "script", lang.value);
    const want = expected[lang.value];
    assert.deepEqual(
      files.map((f) => f.file),
      ["tools/x/tool.md", want.program],
      `${lang.value} writes the wrong files`,
    );

    // The definition points at the program that was actually written —
    // this is the pair `foldrun check` verifies.
    const { data } = matter(files[0].content);
    assert.equal(data.run, want.program.split("/").pop(), `${lang.value}: run: disagrees`);
    assert.match(files[1].content, want.marker, `${lang.value}: not that language`);

    // Every language keeps the same contract: validate the argument the
    // model may omit, and fail loudly rather than returning nothing.
    assert.match(files[1].content, /input/, `${lang.value}: does not read its arg`);
    assert.match(files[1].content, /1|required/, `${lang.value}: no failure path`);
  }
});

test("no language, or an unknown one, still writes a working tool", () => {
  // An older client that does not send the field must not create a folder
  // with a definition and no program.
  for (const files of [toolStarter("x", "script"), toolStarter("x", "script", "klingon" as never)]) {
    assert.deepEqual(files.map((f) => f.file), ["tools/x/tool.md", "tools/x/run.mjs"]);
    assert.equal(matter(files[0].content).data.run, "run.mjs");
  }
});

// The program half of a folder tool must be VISIBLE, not merely writable.
//
// The file tree admitted markdown, scripts/, skill assets and state/ — and
// not tools/<name>/run.*. So the code you were told to edit was writable,
// readable, and absent from the tree that is the only way to reach it. The
// listing now asks the writer, which is the same fix the state/ case got and
// the reason this cannot drift a third time.
test("a folder tool's program appears in the file tree", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
    for (const f of toolStarter("counter", "script", "python")) {
      writeWorkspaceFile("acme", "desk", f.file, f.content);
    }

    const files = listWorkspaceFiles("acme", "desk");
    assert.ok(files.includes("tools/counter/tool.md"), "the definition is listed");
    assert.ok(files.includes("tools/counter/run.py"), "the program is listed");
  }));

test("everything the writer accepts is listed, and nothing it refuses is", () =>
  withData(() => {
    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
    for (const f of toolStarter("counter", "script")) {
      writeWorkspaceFile("acme", "desk", f.file, f.content);
    }
    // The invariant, not a list of paths: a file that can be saved is a file
    // that shows, or someone is told to edit something they cannot find.
    for (const rel of listWorkspaceFiles("acme", "desk")) {
      assert.equal(isEditablePath(rel), true, `${rel} is listed but not editable`);
    }
  }));
