#!/usr/bin/env node
// Cut a release: work out the version, write the changelog, tag it.
//
//   npm run release            what would happen, and nothing else
//   npm run release -- --yes   do it: bump, changelog, commit, tag
//   npm run release -- --minor --yes      raise the inferred bump (never lower it)
//   npm run release -- --pre rc --yes     a pre-release: 1.3.0-rc.1, then rc.2 …
//   --no-tag          commit the bump and changelog, make no tag
//   --notes <file>    also write this version's changelog entry to <file>
//
// Two ways to publish, both through .github/workflows/release.yml:
//   - automatic: every push to main makes .github/workflows/release-pr.yml
//     run this with --yes --no-tag on release/next and keep one pull request
//     open, "release X.Y.Z", the changelog entry as its body. Merging it is
//     the decision: release.yml sees a version on main that has no tag yet,
//     tests, publishes, and tags it.
//   - by hand: `npm run release -- --yes`, then `git push --follow-tags`.
// Either way a person reads the entry before it becomes permanent.
//
// THE VERSION is semantic versioning, held to three rules:
//   PATCH  3.2.16 → 3.2.17  a bug fix, nothing new. Safe to update.
//   MINOR  3.2.16 → 3.3.0   a new feature; everything that worked still works.
//   MAJOR  3.2.16 → 4.0.0   a breaking change: something old stops working
//                           or works differently.
// Two sources decide which, and the larger wins:
//   - the public surface (scripts/surface.mjs), compared between the last
//     tag and HEAD. Something a user could rely on that is gone, or now
//     demands more of them, is a break; something new is a feature. This is
//     what catches the break nobody labelled.
//   - the commits. A subject with `!` before its colon (`runs!: …`) or a
//     body line `BREAKING CHANGE: <what breaks>` marks a break the surface
//     cannot see — a behaviour change. A subject that reads as a fix
//     (fix, docs, test, chore, deps, ci, …) is a patch; anything else is a
//     feature.
// --major / --minor / --patch may raise the bump, never lower it below what
// was found: a detected break is real by definition of the surface.
//
// The rest of SemVer 2.0.0:
//   - The public API is declared: package.json `foldrun.publicApi` for core,
//     `foldrun --help` for the CLI. Anything else may change in any release.
//   - Deprecate before removing. A declaration whose doc comment says
//     `@deprecated` (a help line that says "deprecated") ships in a minor,
//     listed under Deprecated; it goes in a later major. A removal of
//     something never deprecated is still a major, and the entry says so.
//   - Pre-releases: `--pre <id>` makes `<next>-<id>.<n>` (1.3.0-rc.1), by
//     hand only. release.yml publishes it under npm's `next` tag, so
//     `npm install` keeps getting the last stable release. It sorts before
//     1.3.0, which is cut from the same changes when they are ready.
//   - Every version is computed from the last STABLE tag, so the changes in
//     a stable release are everything since the stable before it, pre-releases
//     included. A published version is never changed: npm refuses it, and a
//     fix is the next patch.
//   - No build metadata (`+sha`): npm drops it, and the tag names the commit.
//
// WHY NOT semantic-release / conventional commits: the commit messages in
// this repository are prose, and they are the best description of a change
// anyone will write. Forcing them into `feat(x):` would lose that to gain
// an automation we do not need — one maintainer, a release when there is
// something to release. So: infer the bump, draft the changelog from the
// subjects, and let a person read it before it becomes permanent.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changeOf } from "./surface-change.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const apply = has("--yes");
const noTag = has("--no-tag");
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const notesAt = valueOf("--notes");
const pre = valueOf("--pre");
if (has("--pre") && !/^[0-9A-Za-z-]+$/.test(pre ?? "") ) {
  console.error("--pre takes an identifier: letters, digits and hyphens — rc, beta, alpha");
  process.exit(1);
}
if (pre && /^\d+$/.test(pre)) {
  console.error("--pre takes a name (rc, beta), not a number: the number after it is counted for you");
  process.exit(1);
}

// ---------------------------------------------------------------- the commits

/** The last stable release tag, or null on a repository that has never cut
 *  one. Pre-release tags (v1.3.0-rc.1) are passed over: a stable release
 *  holds everything since the stable before it. */
function lastStableTag() {
  try {
    return git("describe", "--tags", "--abbrev=0", "--match", "v*", "--exclude", "v*-*");
  } catch {
    return null; // never released — every commit is in the first entry
  }
}

const since = lastStableTag();
const range = since ? `${since}..HEAD` : "HEAD";
// Records separated by \x1e, fields by \x00: a commit body is multi-line
// prose, so neither may be a newline.
const commits = git("log", range, "--no-merges", "--format=%x1e%H%x00%s%x00%b")
  .split("\x1e")
  .map((rec) => rec.trim())
  .filter(Boolean)
  .map((rec) => {
    const [sha, subject, body] = rec.split("\0");
    return { sha, subject: subject ?? "", body: body ?? "" };
  })
  // A pre-release's own "release 1.3.0-rc.1" commit is not a change.
  .filter((c) => !/^release \d+\.\d+\.\d+/.test(c.subject));

if (commits.length === 0) {
  console.log(`nothing since ${since ?? "the beginning"} — no release to cut`);
  process.exit(0);
}

// ---------------------------------------------------------------- the version

// What kind of change this is, from the words a person already wrote.
// Deliberately generous about what counts as a feature: shipping a minor
// where a patch would have done costs nothing, and the reverse hides a
// change inside a version number that promised not to have one.
// A break is marked, not mentioned: "this is not a breaking change" in a
// body must not make a major.
const MARKED_BREAK = (c) => /^[^:\n]*!:/.test(c.subject) || /^BREAKING[ -]CHANGES?:/m.test(c.body);
const FIXY = /^(fix|bug|hotfix|typo|docs?|test|chore|deps|build|revert|ci)\b|\bfix(es|ed)?\b/i;

// What the public surface says, between the last tag and HEAD.
const surfaceDiff = await (async () => {
  const at = path.join(root, "scripts", "surface.mjs");
  if (!since || !fs.existsSync(at)) return null;
  const { surface } = await import(at);
  const readAt = (ref) => (p) => {
    try {
      return git("show", `${ref}:${p}`);
    } catch {
      return null;
    }
  };
  const before = surface(readAt(since));
  // The release that first declares the public API has nothing to compare it
  // with: every name would read as new. Say that once instead of listing them.
  if (!Object.keys(before).some((k) => k !== "engines.node")) return { firstDeclared: true, breaking: [], changed: [], deprecated: [], added: [] };
  return compareSurfaces(before, surface(readAt("HEAD")));
})();

/** What changed between two surfaces: breaks, changed declarations,
 *  deprecations, additions. */
function compareSurfaces(before, after) {
  const breaking = [];
  const changed = [];
  const deprecated = [];
  const added = [];
  // A whole entry point gone is one break, not one per name it exported.
  const goneEntries = Object.keys(before)
    .filter((k) => k.startsWith("entry ") && !(k in after))
    .map((k) => k.slice("entry ".length));
  const underGone = (k) => goneEntries.some((e) => k.startsWith(`${e}#`));
  for (const [k, b] of Object.entries(before)) {
    const a = after[k];
    if (!a) {
      if (!underGone(k)) breaking.push(`${b.what} is gone${b.deprecated ? "" : " (it was never deprecated)"}`);
    } else if (b.min != null && a.min != null && a.min > b.min) {
      breaking.push(`${a.what} — was >=${b.min}`);
    } else if (b.required != null && a.required != null && a.required > b.required) {
      breaking.push(`${a.what} now needs ${a.required} argument${a.required === 1 ? "" : "s"}, was ${b.required}`);
    } else if (b.kind !== a.kind || (b.sig ?? "") !== (a.sig ?? "")) {
      // Widened only (optional members or trailing parameters added) is a
      // minor; any other change is a break (surface-change.mjs). Releases
      // merge themselves, so no person reads this list before they ship.
      const c = changeOf(b, a);
      if (c.additive) changed.push(a.what);
      else breaking.push(`${a.what} — ${c.why}`);
    }
    if (a && a.deprecated && !b.deprecated) deprecated.push(a.what);
  }
  for (const [k, a] of Object.entries(after)) if (!(k in before)) added.push(a.what);
  return { breaking, changed, deprecated, added };
}

const RANK = { patch: 0, minor: 1, major: 2 };

function inferBump() {
  if (surfaceDiff?.breaking.length || commits.some(MARKED_BREAK)) return "major";
  if (surfaceDiff?.added.length || surfaceDiff?.changed.length || surfaceDiff?.deprecated.length || commits.some((c) => !FIXY.test(c.subject))) return "minor";
  return "patch";
}

const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const parse = (v) => {
  const m = String(v).match(SEMVER);
  if (!m) throw new Error(`not a semantic version: ${v}`);
  return { maj: +m[1], min: +m[2], pat: +m[3], pre: m[4] ?? null };
};
/** SemVer precedence: <0, 0, >0. A pre-release sorts before its release. */
function cmp(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (const k of ["maj", "min", "pat"]) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre || !y.pre) return (x.pre ? -1 : 0) - (y.pre ? -1 : 0);
  const xs = x.pre.split(".");
  const ys = y.pre.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] == null || ys[i] == null) return xs[i] == null ? -1 : 1;
    const xn = /^\d+$/.test(xs[i]);
    const yn = /^\d+$/.test(ys[i]);
    if (xn && yn && +xs[i] !== +ys[i]) return +xs[i] - +ys[i];
    if (xn !== yn) return xn ? -1 : 1;
    if (!xn && xs[i] !== ys[i]) return xs[i] < ys[i] ? -1 : 1;
  }
  return 0;
}
// The base is the last stable release; package.json may be ahead of it on a
// pre-release, and the next version must still sort after that.
const base = parse(since ? since.slice(1) : pkg.version);
const { maj, min, pat } = base;
const found = inferBump();
const asked = ["major", "minor", "patch"].find((b) => has(`--${b}`));
if (asked && RANK[asked] < RANK[found]) {
  console.error(`--${asked} is below what this release is: a ${found}.`);
  if (found === "major") console.error("A break the surface found is real — something public is gone or demands more. Put it back, or release a major.");
  process.exit(1);
}
const bump = asked ?? found;

// 0.x was "anything may change", where semver lets a minor break things.
// These rules need a major for a break, so the first release under them is
// 1.0.0, whatever kind of change it holds; from then on the rules apply.
let target =
  maj === 0
    ? "1.0.0"
    : bump === "major"
      ? `${maj + 1}.0.0`
      : bump === "minor"
        ? `${maj}.${min + 1}.0`
        : `${maj}.${min}.${pat + 1}`;
// After 1.3.0-rc.2, the release is at least 1.3.0, whatever the bump says.
const current = parse(pkg.version);
if (current.pre) {
  const preBase = `${current.maj}.${current.min}.${current.pat}`;
  if (cmp(preBase, target) > 0) target = preBase;
}
let next = target;
if (pre) {
  // Count the pre-releases of this version with this name already tagged.
  const done = git("tag", "--list", `v${target}-${pre}.*`)
    .split("\n")
    .map((t) => Number(t.slice(`v${target}-${pre}.`.length)))
    .filter((n) => Number.isInteger(n));
  next = `${target}-${pre}.${Math.max(0, ...done) + 1}`;
}
if (cmp(next, pkg.version) <= 0) {
  console.error(`${next} does not sort after ${pkg.version}. A pre-release name sorts by its letters: alpha < beta < rc.`);
  process.exit(1);
}

// ---------------------------------------------------------------- the entry
//
// Grouped by the `scope:` a subject already carries ("browser tool: …"),
// because that is how the person writing them was already thinking.

function scopeOf(subject) {
  const m = subject.match(/^([a-z0-9 ._/+-]{2,28})!?:\s+(.*)$/i);
  return m ? { scope: m[1].trim(), text: m[2].trim() } : { scope: null, text: subject };
}

const groups = new Map();
for (const c of commits) {
  const { scope, text } = scopeOf(c.subject);
  const key = scope ?? "";
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ text, sha: c.sha.slice(0, 7) });
}

const repo = (pkg.repository?.url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
const today = new Date().toISOString().slice(0, 10);
const lines = [`## [${next}] — ${today}`, ""];

// What a person updating needs first: what will stop working for them.
const capped = (list, n = 40) => (list.length > n ? [...list.slice(0, n), `…and ${list.length - n} more`] : list);
const marked = commits.filter(MARKED_BREAK).map((c) => {
  const said = c.body.match(/^BREAKING[ -]CHANGES?:\s*([\s\S]*?)(?:\n\s*\n|$)/m)?.[1]?.replace(/\s+/g, " ").trim();
  return `${said || scopeOf(c.subject.replace(/!:/, ":")).text} (${c.sha.slice(0, 7)})`;
});
const breaks = [...marked, ...(surfaceDiff?.breaking ?? [])];
if (breaks.length) lines.push("### Breaking changes", "", ...capped(breaks).map((b) => `- ${b}`), "");
if (surfaceDiff?.changed.length) {
  lines.push(
    "### Widened in the public API",
    "",
    "Declarations that only widened — optional members or trailing parameters added, nothing removed or retyped. Any other change to a declaration is counted as a break (scripts/surface-change.mjs).",
    "",
    ...capped(surfaceDiff.changed).map((c) => `- ${c}`),
    "",
  );
}
if (surfaceDiff?.deprecated.length) {
  lines.push(
    "### Deprecated",
    "",
    "Still here and still working; to be removed in a later major. Move off them now.",
    "",
    ...capped(surfaceDiff.deprecated).map((d) => `- ${d}`),
    "",
  );
}
if (surfaceDiff?.added.length) lines.push("### New in the public API", "", ...capped(surfaceDiff.added).map((a) => `- ${a}`), "");
if (surfaceDiff?.firstDeclared) lines.push("The public API is declared from this release on; the versions after it are measured against it.", "");

for (const [scope, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (scope) lines.push(`### ${scope}`, "");
  for (const it of items) {
    const link = repo ? ` ([${it.sha}](${repo}/commit/${it.sha}))` : ` (${it.sha})`;
    lines.push(`- ${it.text}${link}`);
  }
  lines.push("");
}
const entry = lines.join("\n").trimEnd() + "\n";

// ---------------------------------------------------------------- do it

if (notesAt) fs.writeFileSync(notesAt, entry);
console.log(`${pkg.name}  ${pkg.version} → ${next}   (${bump}, ${commits.length} commit${commits.length === 1 ? "" : "s"} since ${since ?? "the beginning"})\n`)
if (surfaceDiff) {
  const { breaking, changed, deprecated, added } = surfaceDiff;
  console.log(surfaceDiff.firstDeclared ? `public surface: declared for the first time in this release — nothing to compare with ${since}` : `public surface since ${since}: ${breaking.length} gone or stricter, ${changed.length} changed, ${deprecated.length} deprecated, ${added.length} new`);
}
if (maj === 0) console.log("first release under the semver rules: 0.x → 1.0.0");
if (pre) console.log(`a pre-release: release.yml publishes it under npm's \`next\` tag, not \`latest\``);
console.log("");
console.log(entry);

if (!apply) {
  console.log("— this was a preview. `npm run release -- --yes` to write it, then `git push --follow-tags` to publish.");
  process.exit(0);
}

if (git("status", "--porcelain")) {
  console.error("the working tree is dirty — commit or stash first");
  process.exit(1);
}

const changelogPath = path.join(root, "CHANGELOG.md");
const changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, "utf8") : "# Changelog\n";
const marker = "<!-- releases -->";
fs.writeFileSync(
  changelogPath,
  changelog.includes(marker)
    ? changelog.replace(marker, `${marker}\n\n${entry.trimEnd()}`)
    : `${changelog.trimEnd()}\n\n${entry}`,
);

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// The lockfile carries the version too; a release that leaves it behind
// makes the next `npm ci` disagree with the package it just built. Only
// when git actually TRACKS it: a package that gitignores its lockfile
// still has one on disk, and `git add` on an ignored path fails the whole
// release — which it did, halfway through, leaving a bumped package.json
// with no commit and no tag.
const lockPath = path.join(root, "package-lock.json");
const lockTracked = (() => {
  try {
    return git("ls-files", "--", "package-lock.json") !== "";
  } catch {
    return false;
  }
})();
if (lockTracked) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.version = next;
  if (lock.packages?.[""]) lock.packages[""].version = next;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
}

git("add", "CHANGELOG.md", "package.json", ...(lockTracked ? ["package-lock.json"] : []));
git("commit", "-m", `release ${next}`);
if (noTag) {
  console.log(`\ncommitted release ${next}, no tag — merged to main, release.yml publishes and tags it`);
} else {
  git("tag", "-a", `v${next}`, "-m", `${pkg.name} ${next}`);
  console.log(`\ntagged v${next} — \`git push --follow-tags\` publishes it`);
}
