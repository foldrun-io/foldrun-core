// Guards against the one bug this codebase keeps producing.
//
// Four times in one day: a list of names existed in two places, one was
// updated, the other wasn't, and nothing errored — the UI just quietly lied.
//
//   WORKSPACE_DIRS      the file tree stopped showing knowledge/, evals/, state/
//   LIBRARY_KINDS       scripts sorted second in one list and last in every other
//   ACCOUNT_SEGMENTS    said "shared" after the route became "library", so
//                       /dashboard/library rendered a workspace that didn't exist
//
// A typecheck can't catch any of them: every version compiles. These tests read
// the actual source and assert the lists agree, so the next rename fails loudly
// in CI instead of silently in the interface.
//
//   node --test tests/consistency.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { ALL_KINDS, kindsAt, docKeyOf, docTypeOf, type Kind } from "../packages/core/src/kinds.ts";

import { WORKSPACE_DIRS, templateFiles, anchoredReason, accountFileSealed } from "../packages/core/src/store.ts";
import { starterFiles } from "../packages/core/src/starter.ts";
import { readAgentsMd } from "../packages/core/src/runner.ts";
import { LIBRARY_KINDS } from "../packages/core/src/library.ts";

const root = path.join(import.meta.dirname, "..");

/** Every file under `dir` matching `keep`. */
function walk(dir: string, keep: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      out.push(...walk(full, keep));
    } else if (keep(full)) out.push(full);
  }
  return out;
}

const read = (rel: string) => fs.readFileSync(path.join(import.meta.dirname, "..", rel), "utf8");

/** Pull a quoted string list out of source, e.g. `["a", "b"]`. */
function listIn(source: string, marker: string): string[] {
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `could not find ${marker} — this test needs updating`);
  const open = source.indexOf("[", at);
  const close = source.indexOf("]", open);
  return [...source.slice(open, close).matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
}

test("every account-level directory is a known account segment", () => {
  const dir = path.join(import.meta.dirname, "..", "web/app/dashboard");
  const routes = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("["))
    .map((e) => e.name);

  const declared = new Set(listIn(read("web/components/sidebar.tsx"), "ACCOUNT_SEGMENTS"));

  for (const route of routes) {
    assert.ok(
      declared.has(route),
      `/dashboard/${route} exists but isn't in ACCOUNT_SEGMENTS — the sidebar will treat it ` +
        `as a workspace named "${route}" and render a nav that goes nowhere`,
    );
  }
});

test("the account library holds only nouns a workspace also has", () => {
  for (const kind of LIBRARY_KINDS) {
    assert.ok(
      (WORKSPACE_DIRS as readonly string[]).includes(kind),
      `library has "${kind}/" but a workspace doesn't — a shared thing with nowhere to be overridden`,
    );
  }
});

test("the library cannot hold anything that executes", () => {
  for (const executable of ["agents", "flows", "evals", "state"]) {
    assert.ok(
      !(LIBRARY_KINDS as readonly string[]).includes(executable),
      `"${executable}" is in LIBRARY_KINDS — nothing executes at account level, so it has no ` +
        `secrets scope, no confinement root and nowhere to write runs`,
    );
  }
});

test("noun order is the same in the library, the asset pages and the sidebar", () => {
  // The assets page derives its list from KINDS rather than restating it, so
  // the order under test is the table's own.
  const page = read("web/app/dashboard/[workspace]/assets/page.tsx");
  assert.match(page, /const KINDS = kindsAt\("workspace"\)/,
    "the assets page has gone back to hand-listing its nouns");
  const assetKinds = kindsAt("workspace").filter(
    (k) => k !== "agents" && k !== "flows" && k !== "evals",
  );

  // Order, not just membership. Sorting both sides before comparing is what
  // let the real drift through: scripts sat second in LIBRARY_KINDS and last
  // everywhere else, and a set comparison called that identical.
  assert.deepEqual(
    [...LIBRARY_KINDS],
    assetKinds,
    "the account library lists the nouns in a different order than the asset pages",
  );

  // The sidebar links each noun by ?kind=, so its order is readable from
  // source. It navigates every kind except scripts: a script tool carries
  // its own code inside its folder, so code is material a tool holds rather
  // than a shelf anyone picks from. The directory still exists and still
  // works — it just isn't a decision, so it isn't a door.
  const navigated = assetKinds.filter((k) => k !== "scripts");
  const sidebar = read("web/components/sidebar.tsx");
  const navOrder = [...sidebar.matchAll(/kind=([a-z]+)\$\{accountQuery\}/g)].map((m) => m[1]);
  assert.ok(
    !navOrder.includes("scripts"),
    "scripts is not a shelf any more — a tool folder holds its own code",
  );
  assert.deepEqual(
    navOrder.slice(0, navigated.length),
    navigated,
    "the sidebar lists the nouns in a different order than the asset pages",
  );
});

test("the file tree lists every workspace directory", () => {
  // The tree filters by WORKSPACE_DIRS rather than its own copy — this asserts
  // it still does, since the copy is exactly what went stale before.
  const store = read("packages/core/src/store.ts");
  assert.match(
    store,
    /new RegExp\(`\^\(\$\{WORKSPACE_DIRS\.join\("\|"\)\}\)\//,
    "listWorkspaceFiles has stopped deriving its allowlist from WORKSPACE_DIRS",
  );
});

test("reserved OKF filenames are never treated as concepts", () => {
  const okf = read("packages/core/src/okf.ts");
  for (const reserved of ["index.md", "log.md"]) {
    assert.match(
      okf,
      new RegExp(`RESERVED[\\s\\S]{0,120}${reserved.replace(".", "\\.")}`),
      `${reserved} must be reserved — the spec forbids using it for a concept document`,
    );
  }
});

test("KINDS is the only place a kind is declared", () => {
  // Every noun the product has must come from packages/core/src/kinds.ts. A
  // hand-kept second list is how a kind gets a menu entry with no page, or a
  // creation button that writes a file nothing reads. This test fails the
  // moment someone types the list out again.
  const offenders: string[] = [];
  const files = walk(path.join(root, "web"), (f) => /\.tsx?$/.test(f) && !f.includes("node_modules"));

  for (const file of files) {
    if (file.endsWith("kinds.ts")) continue;
    const src = fs.readFileSync(file, "utf8");
    // A literal array naming three or more kinds is a copy of the table.
    for (const m of src.matchAll(/\[((?:\s*"[a-z]+"\s*,){2,}\s*"[a-z]+"\s*)\]/g)) {
      const items = m[1].split(",").map((s) => s.trim().replace(/"/g, ""));
      const known = items.filter((i) => (ALL_KINDS as readonly string[]).includes(i));
      if (known.length >= 3 && known.length === items.length) {
        offenders.push(`${path.relative(root, file)}: [${items.join(", ")}]`);
      }
    }
  }

  assert.deepEqual(offenders, [], `derive these from KINDS instead:\n${offenders.join("\n")}`);
});

test("a structural document never declares what it is", () => {
  // Its path already says it, and every reader resolves by path. A field
  // restating that is derived data next to its source, free to disagree with
  // it — and `type:` in particular is OKF's, where one of our nouns would be
  // read as a knowledge concept by anything else consuming this repo.
  const bad: string[] = [];
  const data = path.join(root, "data/default");
  const nouns = new Set(["Agent", "Flow", "Eval", "Skill", "Tool"]);

  for (const file of walk(data, (f) => f.endsWith(".md"))) {
    const base = path.basename(file);
    if (base === "index.md" || base === "log.md") continue; // OKF-reserved

    const rel = path.relative(data, file);
    const structural =
      base === "agent.md" ||
      base === "SKILL.md" ||
      /(^|\/)(flows|evals|tools)\//.test(rel);
    if (!structural) continue;

    const front = fs.readFileSync(file, "utf8").split("---")[1] ?? "";
    const declaredKind = /^kind:\s*(.+)$/m.exec(front)?.[1].trim();
    const declaredType = /^type:\s*(.+)$/m.exec(front)?.[1].trim();
    if (declaredKind) bad.push(`${rel}: kind: ${declaredKind} — the path says this`);
    if (declaredType && nouns.has(declaredType)) {
      bad.push(`${rel}: type: ${declaredType} — that is OKF's field`);
    }
  }

  assert.deepEqual(bad, []);
});

test("KINDS only claims a noun where OKF asks for one", () => {
  for (const kind of ALL_KINDS) {
    const key = docKeyOf(kind);
    const noun = docTypeOf(kind);
    assert.ok(key === null || key === "type", `${kind} declares in "${key}" — only OKF's type remains`);
    assert.equal(
      noun === null,
      key === null,
      `${kind} must have a noun exactly when it has a field to put it in`,
    );
    if (key === "type") {
      assert.ok(kind === "memory" || kind === "knowledge", `${kind} is not an OKF bundle`);
    }
  }
});

test("there is exactly one way to create something", () => {
  // Creation drifted into four components — and the workspace one built the
  // file's *content* in the browser, so a skill made by the dashboard and a
  // skill made by `foldrun init` were different files. Everything that makes
  // a thing must go through CreateForm.
  const offenders: string[] = [];

  for (const file of walk(path.join(root, "web"), (f) => /\.tsx$/.test(f))) {
    if (file.endsWith("create.tsx")) continue;
    const src = fs.readFileSync(file, "utf8");
    // A POST whose body *leads* with a name is a creation form. Leading is
    // the signature: connect-style calls (OAuth start) also carry a name,
    // as a parameter among others — those order their body accordingly.
    if (/method:\s*"POST"/.test(src) && /JSON\.stringify\(\{\s*name/.test(src)) {
      offenders.push(path.relative(root, file));
    }
  }

  assert.deepEqual(offenders, [], `these create things outside CreateForm:\n${offenders.join("\n")}`);
});

test("no server component passes a function as a prop", () => {
  // Twice now: a prop typed `(x) => Y` compiles, renders on the server, and
  // throws "Functions cannot be passed directly to Client Components" at the
  // user. The typechecker cannot see it, so this reads the source instead.
  //
  // Catches literal arrows and function expressions only — `prop={someFn}` is
  // indistinguishable from `prop={someValue}` without type information, so a
  // named function passed this way still gets through.
  const offenders: string[] = [];

  for (const file of walk(path.join(root, "web"), (f) => /\.tsx$/.test(f))) {
    const src = fs.readFileSync(file, "utf8");
    if (/^\s*["']use client["']/m.test(src.slice(0, 200))) continue; // client: fine

    for (const re of [/=\{\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g, /=\{\s*function\b/g]) {
      for (const m of src.matchAll(re)) {
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${path.relative(root, file)}:${line}  ${m[0].trim()}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `server components can't hand functions to client components:\n${offenders.join("\n")}`,
  );
});

test("the starter workspace is defined once", () => {
  // `foldrun init` and the dashboard's "+ New workspace" each had their own
  // copy. They drifted to different flow names and different file sets, and
  // when structural documents moved to `kind:` only one copy was migrated —
  // so every workspace made from the dashboard was born in the old format.
  const marker = "agents/researcher/agent.md";
  const owners: string[] = [];

  for (const dir of ["packages", "web"]) {
    for (const file of walk(path.join(root, dir), (f) => /\.(ts|tsx|mjs|js)$/.test(f))) {
      const rel = path.relative(root, file);
      if (rel.includes("/dist/") || rel.endsWith(".test.ts")) continue;
      if (fs.readFileSync(file, "utf8").includes(marker)) owners.push(rel);
    }
  }

  assert.deepEqual(
    owners,
    ["packages/core/src/starter.ts"],
    `the starter workspace must live in starter.ts alone, found in:\n${owners.join("\n")}`,
  );
});

test("both callers scaffold the same workspace, minus what only a laptop keeps", () => {
  // The hosted scaffold is the starter with local-EDITING concerns removed:
  // .gitignore guards a clone's secrets, which the hosted store never keeps in
  // the tree, and CLAUDE.md tells a coding tool the conventions, which is noise
  // in a dashboard file list. Everything else must stay byte-identical, or the
  // dashboard's New button and `foldrun init` drift apart again.
  const LOCAL_ONLY = [".gitignore", "CLAUDE.md"];
  const starter = starterFiles("demo");
  const hosted = templateFiles("demo");
  const localOnly = starter.filter((f) => !hosted.some((h) => h.path === f.path));
  assert.deepEqual(localOnly.map((f) => f.path), LOCAL_ONLY);
  assert.deepEqual(hosted, starter.filter((f) => !LOCAL_ONLY.includes(f.path)));
});

test("the starter workspace obeys the rules it ships", () => {
  // A scaffold that writes fields its own checker warns about is the bug this
  // guards: it happened once already, when the dashboard kept emitting the old
  // spelling after the CLI had moved on.
  const bad: string[] = [];

  for (const { path: rel, content } of starterFiles("demo")) {
    const front = content.split("---")[1] ?? "";
    const isOkf = rel.startsWith("knowledge/") || rel.startsWith("memory/");

    if (/^kind:/m.test(front)) bad.push(`${rel}: declares kind: — the path says it`);
    if (!isOkf && /^type:/m.test(front)) bad.push(`${rel}: declares type: — that is OKF's field`);
    if (isOkf && !/^type:/m.test(front)) bad.push(`${rel}: an OKF concept with no type:`);
  }

  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------- UI system

// The rules the UI audit established, guarded the same way the data lists
// are: read the source, refuse the drift.

const WEB = path.join(import.meta.dirname, "..", "web");

function dashboardPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx") out.push(full);
    }
  };
  walk(path.join(WEB, "app/dashboard"));
  return out;
}

test("content pages share one width; only editors and file trees go wide", () => {
  const wideAllowed = ["[workspace]/edit", "library/edit", "library/files", "[workspace]/storage", "graph"];
  const offenders: string[] = [];
  for (const page of dashboardPages()) {
    const rel = path.relative(path.join(WEB, "app/dashboard"), page);
    const src = fs.readFileSync(page, "utf8");
    const widths = [...src.matchAll(/mx-auto (max-w-\w+)/g)].map((m) => m[1]);
    for (const w of widths) {
      if (w !== "max-w-7xl" && !wideAllowed.some((a) => rel.includes(a))) {
        offenders.push(`${rel}: ${w}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "pages jumped width — max-w-7xl is the standard");
});

test("no component rolls its own dark primary button", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") walk(full);
      else if (entry.name.endsWith(".tsx") && !full.endsWith("components/ui.tsx")) {
        if (/bg-gray-900 px-/.test(fs.readFileSync(full, "utf8"))) {
          offenders.push(path.relative(WEB, full));
        }
      }
    }
  };
  walk(path.join(WEB, "app"));
  walk(path.join(WEB, "components"));
  assert.deepEqual(offenders, [], "a primary button outside buttonClass() is a fork of the design system");
});

test("nothing asks for confirmation through the browser", () => {
  // window.confirm renders with the *origin* as its title, so a destructive
  // action announces itself as "192.168.1.140 says" — indistinguishable from
  // the scam warnings people are trained to dismiss. It also cannot name the
  // dangerous button or show what is about to be deleted. useConfirm() can.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") walk(full);
      else if (entry.name.endsWith(".tsx")) {
        const src = fs.readFileSync(full, "utf8");
        if (/\bwindow\.confirm\(/.test(src)) offenders.push(path.relative(WEB, full));
      }
    }
  };
  walk(path.join(WEB, "app"));
  walk(path.join(WEB, "components"));
  assert.deepEqual(offenders, [], "use useConfirm() from components/confirm.tsx");
});

test("every workspace subpage reaches up through WorkspaceHeader", () => {
  const subpages = ["agents", "flows", "runs", "evals", "assets", "storage", "settings"];
  for (const p of subpages) {
    const src = fs.readFileSync(path.join(WEB, `app/dashboard/[workspace]/${p}/page.tsx`), "utf8");
    assert.ok(src.includes("WorkspaceHeader"), `${p} hand-rolls its header`);
    assert.ok(!src.includes("← Workspaces"), `${p} still points at the account list`);
  }
});

test("an anchored file explains itself instead of failing generically", () => {
  // Location is meaning here, so a refusal has to name the reason: "not an
  // editable path" is true of AGENTS.md and teaches nothing about why.
  for (const [rel, expect] of [
    ["AGENTS.md", /workspace's own identity/],
    ["agents/writer/agent.md", /because of where it sits/],
    ["skills/plain-english/SKILL.md", /names its skill/],
    ["tools/browser/tool.md", /names its tool/],
    ["knowledge/index.md", /generated from the files around it/],
    ["agents/writer/memory/log.md", /generated from the files around it/],
  ] as const) {
    const why = anchoredReason(rel);
    assert.ok(why, `${rel} should be anchored`);
    assert.match(why!, expect);
  }
  // Everything else moves freely.
  for (const rel of ["knowledge/sources.md", "flows/publish.md", "tools/email.md"]) {
    assert.equal(anchoredReason(rel), null, `${rel} should move`);
  }
});

test("the tree's refusals are the server's refusals, word for word", () => {
  // The tree cannot import store.ts (it reads disk), so it mirrors these
  // sentences. A mirror that drifts is worse than no mirror: the gesture
  // would be refused by one and allowed by the other.
  const tree = read("web/components/file-tree.tsx");
  for (const phrase of [
    "is the workspace's own identity",
    "because of where it sits",
    "names its skill",
    "names its tool",
    "generated from the files around it",
    "is its folder's identity",
  ]) {
    assert.ok(tree.includes(phrase), `file-tree.tsx is missing: ${phrase}`);
  }
});

// The account file tree is a faithful walk of the account directory, not a
// curated view of it. A tree that silently differs from the filesystem teaches
// the filesystem wrong — which is why the vault and the ledger are LISTED and
// then refused by name, rather than hidden and wondered about.
test("the vault and the ledger are sealed, and authored files are not", () => {
  const sealed = ["secrets.json", "ledger.jsonl", "oauth-clients.json", "billed/2026-08.json"];
  for (const p of sealed) {
    assert.ok(accountFileSealed(p), `${p} must not be servable`);
  }
  const open = [
    "AGENTS.md",
    "library/tools/browser.md",
    "workspaces/blog-desk/agents/writer/agent.md",
    "storage/blog-desk/index.json",
  ];
  for (const p of open) {
    assert.equal(accountFileSealed(p), null, `${p} is authored and should open`);
  }
  // A workspace's own vault and its run history are sealed the same way.
  assert.ok(accountFileSealed("workspaces/blog-desk/secrets.json"));
  assert.ok(accountFileSealed("workspaces/blog-desk/runs/run-x.json"));
});

test("a pre-rename mdagent_version is migrated, not tolerated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-rename-"));
  fs.writeFileSync(
    path.join(dir, "AGENTS.md"),
    '---\nmdagent_version: "0.1"\nprovider: anthropic\n---\n\nShared context.\n',
  );

  const read = readAgentsMd(dir);
  assert.equal(read?.data.foldrun_version, "0.1", "the reader sees one spelling");
  assert.equal(read?.data.mdagent_version, undefined, "and only one");
  assert.match(
    fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"),
    /^foldrun_version: "0\.1"$/m,
    "the file itself was converted, so the old name retires",
  );
  assert.match(
    fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"),
    /^provider: anthropic$/m,
    "and nothing else about the file moved",
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- role split
//
// The production manifest runs the same image twice — a web tier that serves
// and a worker that drives runs — and the ONLY difference between them is
// FOLDRUN_ROLE. Everything else (the runner image, the size ceilings, all
// eleven secret references) is written out in both, which is exactly the bug
// this file exists to catch: a list in two places, one updated, the other not.
// A worker whose FOLDRUN_RUNNER_IMAGE lagged the web tier's would run every
// step on a stale runner and nothing would say so.

const manifest = () => {
  const docs = yaml.loadAll(read("infra/production/manifests/platform.yaml")) as any[];
  const byName = (kind: string, name: string) =>
    docs.find((d) => d && d.kind === kind && d.metadata?.name === name);
  return { docs, byName };
};

const envOf = (deploy: any) => {
  const env = deploy.spec.template.spec.containers[0].env as any[];
  return new Map(env.map((e) => [e.name, JSON.stringify(e.value ?? e.valueFrom)]));
};

test("web and worker differ by FOLDRUN_ROLE and nothing else", () => {
  const { byName } = manifest();
  const web = envOf(byName("Deployment", "foldrun-web"));
  const worker = envOf(byName("Deployment", "foldrun-worker"));

  assert.equal(web.get("FOLDRUN_ROLE"), JSON.stringify("web"));
  assert.equal(worker.get("FOLDRUN_ROLE"), JSON.stringify("worker"));

  const keys = new Set([...web.keys(), ...worker.keys()]);
  keys.delete("FOLDRUN_ROLE");
  for (const k of keys) {
    assert.equal(
      web.get(k),
      worker.get(k),
      `${k} differs between the web and worker tiers — they run the same image and must agree`,
    );
  }
});

test("exactly one worker, and the Service never routes to it", () => {
  const { byName } = manifest();
  const worker = byName("Deployment", "foldrun-worker");
  const web = byName("Deployment", "foldrun-web");
  const svc = byName("Service", "foldrun");

  // Two workers driving one queue is the failure the worker lease exists to
  // stop. The manifest agrees with the lease rather than leaning on it.
  assert.equal(worker.spec.replicas, 1, "a second worker would double-drive every run");
  assert.equal(worker.spec.strategy.type, "Recreate", "two workers must not overlap during a roll");

  // The whole point of the split: rolling the web tier leaves a server up.
  assert.ok(web.spec.replicas >= 2, "one web replica still has a gap with nothing serving");
  assert.equal(web.spec.strategy.type, "RollingUpdate");

  assert.deepEqual(svc.spec.selector, web.spec.template.metadata.labels);
  assert.notDeepEqual(
    svc.spec.selector,
    worker.spec.template.metadata.labels,
    "dashboard traffic on the worker would compete with driving runs",
  );
});

test("only the worker may create run pods or exec into them", () => {
  // This asserted that web held NO RBAC, which was both wrong and the weaker
  // property: the /stop route runs on web and has to delete a pod, so denying
  // everything meant stop marked the record and left the pod running, billing,
  // until activeDeadlineSeconds reaped it. The invariant that actually matters
  // is the VERBS — starting work and opening a shell inside it belong to the
  // worker alone.
  const { byName, docs } = manifest();
  const worker = byName("Deployment", "foldrun-worker").spec.template.spec.serviceAccountName;
  const web = byName("Deployment", "foldrun-web").spec.template.spec.serviceAccountName;
  assert.notEqual(web, worker, "the tiers must not share an account");

  /** Every verb/resource pair an account can reach, through its bindings. */
  const grants = (account: string) => {
    const roles = docs
      .filter((d) => d && d.kind === "RoleBinding")
      .filter((d) => (d.subjects ?? []).some((s: any) => s.name === account))
      .map((d) => d.roleRef.name);
    const out: string[] = [];
    for (const r of docs.filter((d) => d && d.kind === "Role" && roles.includes(d.metadata.name))) {
      for (const rule of r.rules ?? []) {
        for (const res of rule.resources ?? []) {
          for (const v of rule.verbs ?? []) out.push(`${v} ${res}`);
        }
      }
    }
    return new Set(out);
  };

  const webCan = grants(web);
  const workerCan = grants(worker);

  assert.ok(workerCan.has("create pods"), "the worker must be able to start a run");
  assert.ok(workerCan.has("create pods/exec"), "kubectl cp into a run pod is an exec");

  assert.ok(webCan.has("delete pods"), "stop runs on the web tier and must reach the pod");
  assert.ok(!webCan.has("create pods"), "a dashboard replica must not start work");
  assert.ok(!webCan.has("create pods/exec"), "a dashboard replica must not open a shell in a run");
});

// ------------------------------------------------------- the grammar's docs
//
// A flow step accepts seventeen options, and they arrived one reasonable
// feature at a time. Four of them (`approve:`, `retry:`, `timeout:`,
// `verify:`) were shipped, parsed and clamped without ever reaching SPEC.md —
// found only by counting the parser against the prose. The help page's own
// header says "the consistency suite can't check that". It can.

/** Every option key the flow parser actually accepts. */
function parsedStepOptions(): string[] {
  const src = read("packages/core/src/store.ts");
  const keys = [...src.matchAll(/key === "([a-z-]+)"/g)].map((m) => m[1]);
  // `onfail` is spelled two ways at the parser; documenting one is enough.
  return [...new Set(keys)].filter((k) => k !== "onfail");
}

test("every step option the parser accepts is documented", () => {
  const options = parsedStepOptions();
  assert.ok(options.length >= 15, `expected the full option set, found ${options.length}`);

  const spec = read("SPEC.md");
  const help = read("web/app/dashboard/help/page.tsx");
  // docs/flows.md is the reference both lenses render — the dashboard for
  // people who signed up, site/ for people who have not. An option missing
  // there is missing from the only page someone reads to learn the format.
  const reference = read("docs/flows.md");

  for (const key of options) {
    assert.ok(
      spec.includes(`\`${key}:`) || spec.includes(`${key}:`),
      `step option "${key}:" is parsed but absent from SPEC.md — the format spec has to name it`,
    );
    assert.ok(
      help.includes(`${key}:`),
      `step option "${key}:" is parsed but absent from the in-app help page`,
    );
    assert.ok(
      reference.includes(`${key}:`),
      `step option "${key}:" is parsed but absent from docs/flows.md — the published reference`,
    );
  }
});

/** Every agent.md field the runner reads. */
function agentFields(): string[] {
  const src = read("packages/core/src/runner.ts");
  return [...new Set([...src.matchAll(/front\.([a-zA-Z_]+)/g)].map((m) => m[1]))].filter(Boolean);
}

test("every agent field the runner reads is documented", () => {
  const fields = agentFields();
  assert.ok(fields.length >= 12, `expected the agent field set, found ${fields.length}`);
  const reference = read("docs/agents.md");
  for (const key of fields) {
    assert.ok(
      reference.includes(`\`${key}\``) || reference.includes(`${key}:`),
      `agent field "${key}:" is read by the runner but absent from docs/agents.md`,
    );
  }
});

// The rename of files/ to storage/ reached the code and left the help page
// telling people to write [[files/leads.csv]] — a path that resolves only
// through the legacy alias. Docs that name a directory should name the one
// the code uses.
test("nothing a person reads still names the pre-rename files/", () => {
  // The help page was not the only place. The run-from-step dialog told people
  // their run would "lean on whatever they last left in files/", and the
  // scaling ADR — which now renders inside the app — said "files/ stays R2".
  // Anything a person reads should name the directory the code actually uses.
  const surfaces = [
    "web/app/dashboard/help/page.tsx",
    "web/app/dashboard/[workspace]/flows/flow-board.tsx",
    "site/src/pages/index.astro",
    "site/src/pages/docs/index.astro",
    "docs/scaling-adr.md",
    "docs/grammar-adr.md",
    "SPEC.md",
    "README.md",
  ];
  const offenders: string[] = [];
  for (const rel of surfaces) {
    let src: string;
    try {
      src = read(rel);
    } catch {
      continue; // a doc that no longer exists is not a stale reference
    }
    for (const line of src.split("\n")) {
      // `files` as a bare word is fine ("the file store", "foldrun-files").
      // A PATH segment — files/ — is the thing that was renamed. Skip lines
      // that are explicitly about the legacy alias or the bucket name.
      if (!/(^|[^\w-])files\//.test(line)) continue;
      if (/legacy|LEGACY|foldrun-files|api\/|route/.test(line)) continue;
      offenders.push(`${rel}: ${line.trim().slice(0, 70)}`);
    }
  }
  assert.deepEqual(offenders, [], "files/ was renamed to storage/ — these still say files/");
});

// ------------------------------------------------- what agents are told to do
//
// The prompt tells every agent where to leave deliverables. harvestFiles reads
// exactly one directory. If those two disagree, a run writes its output to a
// place nothing collects and the Storage page stays empty — no error, no
// warning, the run reports success.
//
// That is not hypothetical: after files/ was renamed to storage/, the prompt
// still said `../../files/`. Nothing rescued it either, because
// materializeFiles always creates storage/ before the step, which makes
// adoptLegacyFilesDir's "move files/ into storage/" a no-op by harvest time.

test("agents are told to write where harvestFiles actually reads", () => {
  const runner = read("packages/core/src/runner.ts");
  const storage = read("packages/core/src/storage.ts");

  // The directory the store harvests from, taken from the source of truth.
  const dir = read("packages/core/src/store.ts").match(/export const STORAGE_DIR = "([^"]+)"/)?.[1];
  assert.ok(dir, "STORAGE_DIR should be a literal in store.ts");

  // Only the lines that tell an agent where DELIVERABLES go. Other
  // `../../x/` paths in the prompt (knowledge/, memory/) are read locations
  // and correctly point elsewhere.
  const told = runner
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .filter((l) => /deliverable|file store/i.test(l))
    .flatMap((l) => [...l.matchAll(/\.\.\/\.\.\/([a-z]+)\//g)].map((m) => m[1]))
    .filter((d) => d !== "outputs"); // outputs/ is working text, not delivered
  assert.ok(told.length > 0, "the prompt should name a deliverables directory");

  for (const named of new Set(told)) {
    assert.equal(
      named,
      dir,
      `the prompt tells agents to write to ../../${named}/ but the store harvests ${dir}/ — ` +
        `anything written there is silently never collected`,
    );
  }

  // And harvest really does read that constant rather than a literal.
  assert.match(
    storage,
    /harvestFiles[\s\S]{0,400}STORAGE_DIR/,
    "harvestFiles should read STORAGE_DIR, so this test compares against the real path",
  );
});

// ------------------------------------------------------------------ clocks
//
// toLocaleString() in a server component formats on the BOX. Every viewer then
// reads the server's clock — "8:26 AM" meaning nothing to anyone in another
// city. LocalTime and RunDot exist because of that; this keeps the pattern.
//
// The one legitimate server-side format is a schedule preview, which quotes a
// cron's own declared timezone and must pass `timeZone` explicitly to say so.

test("one place decides which clock a viewer reads", () => {
  const roots = ["web/app", "web/components"];
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(import.meta.dirname, "..", dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) walk(rel);
        continue;
      }
      if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;
      const src = read(rel);
      // viewer-time.tsx IS the owner of this decision; it is allowed to call
      // Intl directly. Everything else goes through it.
      if (rel.endsWith("components/viewer-time.tsx")) continue;
      for (const line of src.split("\n")) {
        const code = line.trimStart();
        if (code.startsWith("//") || code.startsWith("*")) continue; // prose, not a call
        if (!/toLocale(String|DateString|TimeString)\s*\(/.test(line)) continue;
        // Passing an explicit timeZone is a deliberate, deterministic choice.
        if (/timeZone/.test(line)) continue;
        offenders.push(`${rel}: ${line.trim().slice(0, 72)}`);
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(
    offenders,
    [],
    "these format a timestamp outside components/viewer-time.tsx, so they ignore the zone " +
      "the person chose on their profile. Use <LocalTime> or useViewerTime(), or pass an " +
      "explicit timeZone when the zone itself is the subject (a schedule preview).",
  );
});

// The secret is written in two places and read in a third. bootstrap.sh
// creates it, token-refresh.sh REPLACES it every hour, and platform.yaml
// mounts keys out of it — and `create secret --dry-run | apply` replaces the
// whole object, so a key in bootstrap but not in token-refresh exists only
// until the timer next fires.
//
// This is the bug this file was written for, in its most expensive form:
// postgres-password was added to bootstrap.sh and not to token-refresh.sh, and
// nothing failed for three days, because running pods keep the environment
// they started with. The next pod created — a deploy, an eviction, a reboot —
// died in CreateContainerConfigError, pointing at the deploy rather than at a
// timer that had quietly emptied the key hours earlier.

/** Every --from-literal key a shell script writes into ONE named secret.
 *  Scoped to the block, because these scripts create more than one secret and
 *  the lists are only required to agree per-secret. */
function secretKeysIn(rel: string, secret = "foldrun-keys"): Set<string> {
  const source = read(rel);
  const at = source.indexOf(`create secret generic ${secret}`);
  if (at === -1) return new Set();
  // The block runs to the --dry-run that terminates the pipeline.
  const end = source.indexOf("--dry-run", at);
  const block = source.slice(at, end === -1 ? undefined : end);
  return new Set([...block.matchAll(/--from-literal=([a-zA-Z0-9_-]+)=/g)].map((m) => m[1]));
}

test("bootstrap and token-refresh write the same secret keys", () => {
  const bootstrap = secretKeysIn("infra/production/bootstrap.sh");
  const refresh = secretKeysIn("infra/production/token-refresh.sh");
  assert.ok(bootstrap.size > 5, "found the bootstrap key list at all");
  const missing = [...bootstrap].filter((k) => !refresh.has(k));
  assert.deepEqual(
    missing,
    [],
    `token-refresh.sh replaces the whole secret, so these keys would be deleted ` +
      `the next time the timer fires: ${missing.join(", ")}`,
  );
  const extra = [...refresh].filter((k) => !bootstrap.has(k));
  assert.deepEqual(extra, [], `keys a fresh box would never get: ${extra.join(", ")}`);
});

test("every secret key the manifests read is one the scripts write", () => {
  const written = secretKeysIn("infra/production/bootstrap.sh");
  const manifest = read("infra/production/manifests/platform.yaml");
  const referenced = [
    ...manifest.matchAll(/secretKeyRef:\s*\{\s*name:\s*foldrun-keys,\s*key:\s*([a-z0-9-]+)([^}]*)\}/g),
  ];
  assert.ok(referenced.length > 5, "found the secretKeyRefs at all");
  for (const [, key, rest] of referenced) {
    // An optional key may be absent by design; a required one may not.
    if (rest.includes("optional: true")) continue;
    assert.ok(written.has(key), `platform.yaml requires ${key}, which bootstrap.sh never writes`);
  }
});

test("the scripts restart deployments that exist", () => {
  // Every manifest, not just platform.yaml: the datastores are Deployments
  // too, and token-refresh.sh reaches deploy/foldrun-postgres to ask the
  // queue whether a run is in flight before it restarts the worker.
  const docs = [
    "infra/production/manifests/platform.yaml",
    "infra/production/manifests/datastores.yaml",
  ].flatMap((f) => yaml.loadAll(read(f)) as any[]);
  const deployments = new Set(
    docs.filter((d) => d?.kind === "Deployment").map((d) => d.metadata.name as string),
  );
  for (const rel of ["infra/production/token-refresh.sh", "infra/production/deploy.sh"]) {
    for (const [, name] of read(rel).matchAll(/deploy\/([a-z0-9-]+)/g)) {
      // deploy.sh deletes the pre-split deployment on purpose; it is the one
      // name that is expected NOT to be in the manifests.
      if (name === "foldrun-platform" && rel.endsWith("deploy.sh")) continue;
      assert.ok(deployments.has(name), `${rel} names deploy/${name}, which no manifest creates`);
    }
  }
});

// The host scripts are the third place a change can land and not run. They
// are systemd timers on the box, so deploy.sh's rollout never touches them —
// install-host-scripts.sh is the one thing that does, and both bootstrap.sh
// and deploy.sh call it. These tests keep its three lists agreeing with the
// unit files beside it.

const installer = () => read("infra/production/install-host-scripts.sh");

test("every unit file in the directory is one the installer installs", () => {
  const onDisk = fs
    .readdirSync(path.join(root, "infra/production"))
    .filter((f) => f.endsWith(".service") || f.endsWith(".timer"))
    .map((f) => f.replace(/\.(service|timer)$/, ""));
  assert.ok(onDisk.length > 0, "found unit files at all");
  const listed = (installer().match(/^UNITS="([^"]+)"/m)?.[1] ?? "")
    .split(/\s+/)
    .filter(Boolean);
  assert.ok(listed.length > 0, "found the UNITS list at all");
  for (const unit of new Set(onDisk)) {
    assert.ok(listed.includes(unit), `${unit} has unit files but the installer never installs it`);
  }
});

test("every ExecStart points at a path the installer writes", () => {
  const installs = new Set(
    [...installer().matchAll(/^[a-z-]+\.sh:(\S+)$/gm)].map((m) => m[1]),
  );
  assert.ok(installs.size > 0, "found the script map at all");
  for (const f of fs.readdirSync(path.join(root, "infra/production"))) {
    if (!f.endsWith(".service")) continue;
    const exec = read(`infra/production/${f}`).match(/^ExecStart=(\S+)/m)?.[1];
    assert.ok(exec, `${f} has no ExecStart`);
    assert.ok(installs.has(exec!), `${f} runs ${exec}, which nothing installs`);
  }
});

test("only the installer installs host scripts — one definition, not three", () => {
  // bootstrap.sh used to do this itself, which is exactly why a fixed
  // token-refresh.sh could sit unrun on the box for three days.
  for (const rel of ["infra/production/bootstrap.sh", "infra/production/deploy.sh"]) {
    assert.equal(
      /install -m755[^\n]*\/usr\/local\/bin\/foldrun-/.test(read(rel)),
      false,
      `${rel} installs a host script directly instead of calling install-host-scripts.sh`,
    );
  }
});

// --------------------------------------------------------- cluster hardening
//
// A kubescape scan took the manifests from 63% to 96% on the NSA framework.
// Everything below is one of those fixes, kept as a test because a scan is
// something someone remembers to run and a test is not.
//
// What is deliberately NOT asserted, because it is architecture rather than
// oversight: the worker holds pods/exec (kubectl cp into a run pod IS an exec)
// and both tiers mount a service-account token (both call the API — the worker
// creates run pods, the web tier deletes one when you press Stop).

test("no container in the cluster runs as root", () => {
  const docs = [
    ...(manifest().docs),
    ...(yaml.loadAll(read("infra/production/manifests/datastores.yaml")) as any[]),
  ].filter(Boolean);
  for (const d of docs.filter((x) => x.kind === "Deployment")) {
    const pod = d.spec.template.spec;
    assert.equal(
      pod.securityContext?.runAsNonRoot,
      true,
      `${d.metadata.name} does not declare runAsNonRoot`,
    );
    assert.ok(
      typeof pod.securityContext?.runAsUser === "number" && pod.securityContext.runAsUser !== 0,
      `${d.metadata.name} must name the non-root uid it runs as`,
    );
  }
});

test("every container drops capabilities and cannot write its own image", () => {
  const docs = [
    ...(manifest().docs),
    ...(yaml.loadAll(read("infra/production/manifests/datastores.yaml")) as any[]),
  ].filter(Boolean);
  for (const d of docs.filter((x) => x.kind === "Deployment")) {
    for (const c of d.spec.template.spec.containers) {
      const sc = c.securityContext ?? {};
      assert.equal(sc.allowPrivilegeEscalation, false, `${d.metadata.name}/${c.name}`);
      assert.deepEqual(sc.capabilities?.drop, ["ALL"], `${d.metadata.name}/${c.name}`);
      assert.equal(sc.readOnlyRootFilesystem, true, `${d.metadata.name}/${c.name}`);
    }
  }
});

test("every workload is covered by a NetworkPolicy that names it", () => {
  // matchLabels, not matchExpressions: kubescape could not resolve the
  // expression form, and a policy no tool can evaluate is one nobody can
  // audit. The selector has to say the app out loud.
  const docs = [
    ...(manifest().docs),
    ...(yaml.loadAll(read("infra/production/manifests/datastores.yaml")) as any[]),
  ].filter(Boolean);
  const policies = docs.filter((d) => d.kind === "NetworkPolicy");
  for (const d of docs.filter((x) => x.kind === "Deployment")) {
    const app = d.spec.template.metadata.labels.app;
    const covering = policies.find((p) => p.spec.podSelector?.matchLabels?.app === app);
    assert.ok(covering, `${d.metadata.name} is not covered by any NetworkPolicy`);
    assert.deepEqual(
      [...covering.spec.policyTypes].sort(),
      ["Egress", "Ingress"],
      `${app}'s policy must restrict both directions`,
    );
  }
});

test("the datastores may not open an outbound connection except DNS", () => {
  // A database that can reach the internet is a database that can exfiltrate
  // to it. Verified on the box: postgres cannot open 1.1.1.1:443.
  const docs = (yaml.loadAll(read("infra/production/manifests/datastores.yaml")) as any[]).filter(Boolean);
  for (const app of ["foldrun-postgres", "foldrun-redis"]) {
    const p = docs.find((d) => d.kind === "NetworkPolicy" && d.metadata.name === app);
    assert.ok(p, `no policy for ${app}`);
    const ports = p.spec.egress.flatMap((e: any) => (e.ports ?? []).map((x: any) => x.port));
    assert.deepEqual([...new Set(ports)], [53], `${app} may egress only to DNS`);
  }
});

// An alert on a metric nothing emits never fires, and a never-firing alert is
// indistinguishable from a healthy system. So every foldrun_* metric named in
// the rules has to be one something actually produces — the API endpoint or
// the host collector.
test("every foldrun_ metric an alert references is one we emit", () => {
  const emitted = new Set([
    ...[...read("web/app/api/metrics/route.ts").matchAll(/^\s*"# HELP (foldrun_\w+)/gm)].map((m) => m[1]),
    ...[...read("infra/production/node-metrics.sh").matchAll(/# HELP (foldrun_\w+)/g)].map((m) => m[1]),
  ]);
  assert.ok(emitted.size > 5, "found the emitted metric names at all");
  const referenced = new Set(
    [...read("infra/production/observability/alerts.yaml").matchAll(/\b(foldrun_\w+)/g)].map((m) => m[1]),
  );
  assert.ok(referenced.size > 3, "found the alert expressions at all");
  for (const metric of referenced) {
    assert.ok(emitted.has(metric), `alerts.yaml watches ${metric}, which nothing emits`);
  }
});

// production.env.example is the only copy of the environment anyone can read —
// the real file is gitignored, and rightly so. That makes it the fourth list in
// this file that drifts: bootstrap.sh gained FOLDRUN_POSTGRES_PASSWORD as a
// HARD requirement (${VAR:?}, so the script exits) and the example never
// mentioned it, which means the documented way to build a fresh box stopped
// working and nothing said so.
test("every variable bootstrap.sh requires is documented in the example", () => {
  const example = read("infra/production/production.env.example");
  const scripts = ["bootstrap.sh", "token-refresh.sh", "backup.sh", "node-metrics.sh"]
    .map((f) => read(`infra/production/${f}`))
    .join("\n");

  // ${VAR:?...} — the script refuses to run without it.
  const required = new Set(
    [...scripts.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)].map((m) => m[1]),
  );
  assert.ok(required.size > 2, "found the required-variable syntax at all");
  for (const key of required) {
    assert.ok(
      new RegExp(`\\b${key}=`).test(example),
      `bootstrap refuses to run without ${key}, and the example never mentions it`,
    );
  }

  // ${VAR:-} with an EMPTY default — optional, but read from the env file, so
  // it still needs a line or nobody knows it exists. A non-empty default
  // (${K3S_CHANNEL:-stable}) is a knob with a built-in answer, not something
  // anyone puts in the file, and SUDO_USER is handed to the script by sudo.
  const FROM_THE_ENVIRONMENT = new Set(["SUDO_USER"]);
  const optional = new Set(
    [...scripts.matchAll(/\$\{([A-Z][A-Z0-9_]*):-\}/g)]
      .map((m) => m[1])
      .filter((k) => !FROM_THE_ENVIRONMENT.has(k)),
  );
  const undocumented = [...optional].filter((k) => !new RegExp(`\\b${k}=`).test(example));
  assert.deepEqual(
    undocumented,
    [],
    `read by the install scripts but documented nowhere: ${undocumented.join(", ")}`,
  );
});

// The scaffolded CLAUDE.md is what a coding tool reads instead of guessing, so
// a feature missing from it is a feature the author's tool does not know
// exists. That is the same failure as prose reaching no model: the capability
// is there and nothing says so. `.claude/agents/` import worked for months
// before anything told anyone.
test("the scaffolded CLAUDE.md names every directory and agent field", () => {
  const claude = starterFiles("demo").find((f) => f.path === "CLAUDE.md");
  assert.ok(claude, "the scaffold must ship a CLAUDE.md");
  const doc = claude!.content;

  for (const dir of WORKSPACE_DIRS) {
    assert.ok(doc.includes(`${dir}/`), `CLAUDE.md never mentions ${dir}/`);
  }

  // Frontmatter the runner actually reads. Taken from runner.ts rather than
  // listed here, so a field added there fails this until it is documented.
  const fields = new Set(
    [...read("packages/core/src/runner.ts").matchAll(/\bfront\.([A-Za-z][A-Za-z0-9_]*)/g)].map(
      (m) => m[1],
    ),
  );
  // `front.x` that are not author-facing knobs: internals and re-reads.
  const NOT_AUTHORED = new Set(["foldrun_version", "name", "description", "kind", "type"]);
  const undocumented = [...fields]
    .filter((f) => !NOT_AUTHORED.has(f))
    .filter((f) => !doc.includes(`${f}:`));
  assert.deepEqual(
    undocumented,
    [],
    `runner.ts reads these from an agent's frontmatter and CLAUDE.md never ` +
      `mentions them, so nobody authoring with a coding tool will use them: ` +
      `${undocumented.join(", ")}`,
  );

  // Step options, from parseFlow's own if-chain. Same argument: an option the
  // parser accepts and this file never mentions is a feature that exists only
  // for people who read the source.
  const store = read("packages/core/src/store.ts");
  const parseFlowBody = store.slice(store.indexOf("export function parseFlow"));
  const options = new Set(
    [...parseFlowBody.slice(0, parseFlowBody.indexOf("steps.sort")).matchAll(
      /key === "([a-z-]+)"/g,
    )].map((m) => m[1]),
  );
  assert.ok(options.size > 10, "found parseFlow's option list at all");
  // `onfail` is an accepted spelling of `on-fail`, not a second feature.
  const missingOptions = [...options].filter(
    (o) => o !== "onfail" && !doc.includes(`${o}:`),
  );
  assert.deepEqual(
    missingOptions,
    [],
    `parseFlow accepts these step options and CLAUDE.md never mentions them: ` +
      `${missingOptions.join(", ")}`,
  );
});

// docs/api.md is the only description of the HTTP surface anyone has. A route
// that exists and is not in it is a capability nobody outside this repo can
// find — the same failure as an undocumented frontmatter field, one layer up.
test("every API route is in docs/api.md", () => {
  const doc = read("docs/api.md");
  const apiRoot = path.join(root, "web/app/api");

  const routes: string[] = [];
  const walkApi = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkApi(full);
      else if (e.name === "route.ts") {
        routes.push("/api/" + path.relative(apiRoot, dir).split(path.sep).join("/"));
      }
    }
  };
  walkApi(apiRoot);
  assert.ok(routes.length > 40, `found only ${routes.length} routes — is the walk right?`);

  const missing = routes.filter((r) => {
    // The doc writes <ws> for [workspace] and <flow> for [flow] — compare on
    // the shape, not the placeholder spelling, or this only ever checks the
    // routes with no parameters in them.
    const shape = r
      .replace("/api/workspaces/[workspace]", "/api/workspaces/<ws>")
      .replace(/\[[a-zA-Z]+\]/g, "<>");
    const asWritten = doc.replace(/<[a-zA-Z]+>/g, "<>");
    return !asWritten.includes(shape.replace(/<[a-zA-Z]+>/g, "<>"));
  });
  assert.deepEqual(
    missing,
    [],
    `these routes exist and docs/api.md never mentions them:\n  ${missing.join("\n  ")}`,
  );
});

// ------------------------------------------------- the site and the app split
//
// foldrun.com and the dashboard used to be one Next server: web/app/page.tsx
// was the landing page, so the marketing site went down when the box did and
// could only ship when the app shipped. The site now lives in site/ — static
// Astro, its own host — and the app's root is a redirect to /dashboard.
//
// A split like that is undone one reasonable commit at a time: a landing
// section added back to the app "just for now", a doc copied into site/ to
// tweak the wording, a "Sign in" written as /login because it works in dev.
// These tests are what makes each of those fail loudly instead.

/** Every file under site/src, which is small enough to read whole. */
function siteSources(): { rel: string; src: string }[] {
  const dir = path.join(root, "site", "src");
  return walk(dir, () => true).map((f) => ({
    rel: path.relative(root, f),
    src: fs.readFileSync(f, "utf8"),
  }));
}

test("the docs are not forked into the site — it renders docs/ itself", () => {
  // A copy under site/ would render fine and be outside every test that keeps
  // docs/*.md honest against the code. The collection has to point up and out.
  const config = read("site/src/content.config.ts");
  assert.match(
    config,
    /base:\s*"\.\.\/docs"/,
    "site's docs collection must load the repo's docs/, not a copy inside site/",
  );

  const copies = siteSources().filter((f) => f.rel.endsWith(".md"));
  assert.deepEqual(
    copies.map((f) => f.rel),
    [],
    "markdown under site/src is a second copy of docs/ waiting to drift",
  );
});

test("the grouping lives in one place, not once per surface", () => {
  // packages/docs-index is the shared home. Either app growing its own GROUPS
  // is the start of two docs sections that disagree about what order to read
  // them in — which is how design-notes.ts and docs-index.ts came to exist.
  const shared = read("packages/docs-index/index.ts");
  assert.match(shared, /export const GROUPS/, "the shared index defines the grouping");

  for (const { rel, src } of siteSources()) {
    assert.ok(
      !/const GROUPS\s*[:=]/.test(src),
      `${rel} defines its own GROUPS — import it from packages/docs-index instead`,
    );
  }
});

test("the site links to the app by origin, never by path", () => {
  // href="/login" resolves to foldrun.com/login, which the static host has no
  // page for. Every link into the app goes through site.ts, which builds it
  // from PUBLIC_APP_URL.
  const offenders: string[] = [];
  for (const { rel, src } of siteSources()) {
    if (rel.endsWith("site.ts")) continue; // where the two origins are defined
    for (const line of src.split("\n")) {
      if (/href="\/(login|signup|dashboard)/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "these link to app pages as if they were on this host");
});

test("the app's root is a redirect, not a second landing page", () => {
  const page = read("web/app/page.tsx");
  // Every destination proxy.ts knows about. The empty-install case is the one
  // that gets forgotten: a first operator sent to /login cannot pass it, and
  // signup is the only door that opens.
  for (const to of ["/dashboard", "/login", "/signup"]) {
    assert.match(page, new RegExp(`"${to}"`), `web/app/page.tsx never sends anyone to ${to}`);
  }
  // The pitch is one thing that must exist in exactly one place: two copies of
  // it is two copies to keep true as the product changes.
  const pitch = "Agents are just";
  assert.ok(!page.includes(pitch), "the landing copy belongs in site/, not in the app");
  assert.ok(read("site/src/pages/index.astro").includes(pitch), "…and the site should still have it");
});
