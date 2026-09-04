// The gallery's two folder tools, exercised as programs — not only as
// strings that install. The sql script actually runs under python3 against
// files on disk; the browser program is syntax-checked as an ES module and
// its definition read for the arguments it promises. Chromium is never
// launched here.
//
//   node --test tests/gallery-tools.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { GALLERY, galleryTemplate, installGalleryTool } from "../packages/core/src/gallery.ts";
import { readLibraryFile } from "../packages/core/src/library.ts";
import { fencedCode, parseToolDef, saveWorkspace, workspaceTools } from "../packages/core/src/store.ts";
import { missingToolPrograms } from "../packages/core/src/tool-programs.ts";

const sql = GALLERY.find((t) => t.name === "sql")!;
const browser = GALLERY.find((t) => t.name === "browser")!;

function withData(body: () => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-gallery-tools-"));
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

/** A scratch agent directory holding the sql program and two data files. */
function withSqlDir(body: (run: (args: string[]) => ReturnType<typeof spawnSync>) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-sql-"));
  const agent = path.join(dir, "agent");
  fs.mkdirSync(path.join(agent, "tools", "sql"), { recursive: true });
  const program = path.join(agent, "tools", "sql", "run.py");
  fs.writeFileSync(program, sql.wrapper!.content);
  fs.writeFileSync(
    path.join(agent, "people.csv"),
    "id,name,city,age\n1,Ann,Sydney,34\n2,Bob,Perth,41\n3,Cy,Sydney,29\n",
  );
  // An object holding the rows under one key, with numbers left as numbers.
  fs.writeFileSync(
    path.join(agent, "orders.json"),
    JSON.stringify({
      generated: "2026-09-02",
      orders: [
        { id: 10, person_id: 1, amount: 120.5 },
        { id: 11, person_id: 1, amount: 30 },
        { id: 12, person_id: 3, amount: 9.25 },
      ],
    }),
  );
  // Outside the agent directory: the file the path check must refuse.
  fs.writeFileSync(path.join(dir, "secret.csv"), "k\nhunter2\n");
  try {
    body((args) => spawnSync("python3", [program, ...args], { cwd: agent, encoding: "utf8" }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- sql

test("sql ships as a folder tool: a definition, and stdlib Python beside it", () => {
  assert.ok(sql, "sql tool exists");
  assert.equal(sql.kind, "tools");
  assert.equal(sql.file, "sql/tool.md");
  assert.equal(sql.snippet, "tools: [sql]");
  assert.equal(sql.wrapper?.file, "sql/run.py");

  const { data, content } = matter(sql.content);
  const def = parseToolDef(data as Record<string, unknown>, "sql", content);
  assert.equal(def!.kind, "script");
  const spec = def!.spec as { run?: string; code?: string; args: Record<string, string>; timeout?: number };
  assert.equal(spec.run, "run.py");
  assert.equal(spec.code, undefined);
  assert.deepEqual(Object.keys(spec.args), ["query", "files", "limit", "format"]);
  assert.equal(spec.timeout, 120);
  // The prose's examples must not read as the program.
  assert.equal(fencedCode(content), null);

  // Stdlib only, and the description says when to reach for it.
  assert.doesNotMatch(sql.wrapper!.content, /^\s*(import|from) (pandas|numpy|duckdb)/m);
  assert.match(sql.content, /Arithmetic belongs in a query, not in prose/);
  assert.match(sql.content, /CAST\(/, "the CSV-is-TEXT note shows the cast");
});

test("installing sql writes both files, and the installed tool loads with its program", () =>
  withData(() => {
    assert.equal(installGalleryTool("acme", "sql"), "sql/tool.md");
    assert.match(readLibraryFile("acme", "tools", "sql/run.py"), /sqlite3/);

    saveWorkspace("acme", "desk", [{ path: "AGENTS.md", content: "---\nname: desk\n---\n" }]);
    installGalleryTool("acme", "sql", "desk");
    const def = workspaceTools("acme", "desk").sql;
    assert.equal(def.kind, "script");
    assert.equal((def.spec as { run?: string }).run, "workspace/tools/sql/run.py");
    assert.deepEqual(missingToolPrograms("acme", "desk"), []);
  }));

test("starting from sql seeds a renamed folder", () => {
  const seed = galleryTemplate("tools", "sql", "my-sql")!;
  assert.deepEqual(seed.map((f) => f.file), ["my-sql/tool.md", "my-sql/run.py"]);
  assert.equal(matter(seed[0].content).data.run, "run.py");
  assert.match(seed[0].content, /tools: \[my-sql\]/);
});

test("sql: two files become two tables, and a JOIN with an aggregate runs across them", () =>
  withSqlDir((run) => {
    const r = run([
      "--files", "people.csv,orders.json",
      "--format", "json",
      "--query",
      "SELECT p.name, COUNT(o.id) AS n, SUM(o.amount) AS total " +
        "FROM people p LEFT JOIN orders o ON o.person_id = CAST(p.id AS INTEGER) " +
        "GROUP BY p.name ORDER BY total DESC",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const rows = JSON.parse(r.stdout);
    assert.deepEqual(rows, [
      { name: "Ann", n: 2, total: 150.5 },
      { name: "Cy", n: 1, total: 9.25 },
      { name: "Bob", n: 0, total: null },
    ]);
    assert.match(r.stderr, /3 rows/);
  }));

test("sql: CSV values are TEXT until cast, and the csv format is parseable", () =>
  withSqlDir((run) => {
    const r = run([
      "--files", "people.csv",
      "--format", "csv",
      "--query", "SELECT city, SUM(CAST(age AS INTEGER)) AS age_sum FROM people GROUP BY city ORDER BY city",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "city,age_sum\nPerth,41\nSydney,63");

    // The default table format: a header, a rule, the rows.
    const t = run(["--files", "people.csv", "--query", "SELECT name FROM people WHERE city = 'Sydney'"]);
    assert.equal(t.status, 0, t.stderr);
    assert.deepEqual(t.stdout.trim().split("\n"), ["name", "----", "Ann", "Cy"]);
  }));

test("sql: limit caps the rows and says more exist", () =>
  withSqlDir((run) => {
    const r = run(["--files", "people.csv", "--limit", "2", "--format", "json", "--query", "SELECT id FROM people"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).length, 2);
    assert.match(r.stderr, /limit 2 reached/);
  }));

test("sql: anything but a single SELECT is refused, and says why", () =>
  withSqlDir((run) => {
    const del = run(["--files", "people.csv", "--query", "DELETE FROM people"]);
    assert.notEqual(del.status, 0);
    assert.match(del.stderr, /only a single SELECT/);

    // A write smuggled in behind WITH: the authorizer catches what the
    // first-keyword check cannot.
    const cte = run(["--files", "people.csv", "--query", "WITH x AS (SELECT 9 AS a) INSERT INTO people(id) SELECT a FROM x"]);
    assert.notEqual(cte.status, 0);
    assert.match(cte.stderr, /not authorized/);

    // Two statements: SQLite itself refuses the second.
    const two = run(["--files", "people.csv", "--query", "SELECT 1; DROP TABLE people"]);
    assert.notEqual(two.status, 0);
    assert.match(two.stderr, /one statement/i);

    // A wrong column gets the schema back, so the next query can be right.
    const bad = run(["--files", "people.csv", "--query", "SELECT nope FROM people"]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /no such column: nope.*people\(id, name, city, age\)/);
  }));

test("sql: a path that escapes the working directory is refused", () =>
  withSqlDir((run) => {
    const r = run(["--files", "../secret.csv", "--query", "SELECT * FROM secret"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /outside the working directory/);
    assert.doesNotMatch(r.stdout, /hunter2/);
  }));

// --------------------------------------------------------------- browser

test("the browser program parses as an ES module and keeps its guards", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-browser-"));
  try {
    const file = path.join(dir, "run.mjs");
    fs.writeFileSync(file, browser.wrapper!.content);
    const r = spawnSync("node", ["--check", file], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const src = browser.wrapper!.content;
  assert.match(src, /chromium\.launch\(/, "the plain launch stays for session-less calls");
  assert.match(src, /chromium\.launchPersistentContext\(/, "a session is a persistent profile");
  assert.match(src, /outputs[/"', ]+\.browser/, "the profile lives under outputs/");
  assert.match(src, /--no-sandbox/);
  assert.match(src, /MAX_CHARS = 18_000/);
  for (const action of ["click", "fill", "press", "select", "wait", "goto", "screenshot", "scroll"]) {
    assert.match(src, new RegExp(`"${action}"`), `${action} is a known action`);
  }
});

test("the browser definition lists the new arguments and stays backward compatible", () => {
  const { data, content } = matter(browser.content);
  const def = parseToolDef(data as Record<string, unknown>, "browser", content);
  assert.equal(def!.kind, "script");
  const spec = def!.spec as { run?: string; args: Record<string, string>; timeout?: number };
  assert.equal(spec.run, "run.mjs");
  assert.equal(spec.timeout, 120);
  // The original three first, so nothing that called browser(url) changes.
  assert.deepEqual(Object.keys(spec.args), ["url", "wait_for", "mode", "actions", "session"]);
  assert.match(spec.args.mode, /screenshot/);
  for (const action of ["click", "fill", "press", "select", "wait", "goto", "screenshot", "scroll"]) {
    assert.match(spec.args.actions, new RegExp(`"${action}"`), `${action} is documented`);
  }
  assert.match(spec.args.session, /outputs\/\.browser/);
  // Honest about limits, and about where the session directory lands.
  assert.match(content, /wait_for/);
  assert.match(content, /archived with the run and never deployed/);
  assert.equal(fencedCode(content), null);
});
