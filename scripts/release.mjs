#!/usr/bin/env node
// Cut a release: work out the version, write the changelog, tag it.
//
//   npm run release            what would happen, and nothing else
//   npm run release -- --yes   do it: bump, changelog, commit, tag
//   npm run release -- --minor --yes      override the inferred bump
//
// Pushing the tag is what publishes (.github/workflows/release.yml). That
// separation is deliberate: this script is safe to run and read, and the
// irreversible step is one `git push --follow-tags` you type yourself.
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const apply = has("--yes");

// ---------------------------------------------------------------- the commits

/** The last release tag, or null on a repository that has never cut one. */
function lastTag() {
  try {
    return git("describe", "--tags", "--abbrev=0", "--match", "v*");
  } catch {
    return null; // never released — every commit is in the first entry
  }
}

const since = lastTag();
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
  });

if (commits.length === 0) {
  console.log(`nothing since ${since ?? "the beginning"} — no release to cut`);
  process.exit(0);
}

// ---------------------------------------------------------------- the version

// What kind of change this is, from the words a person already wrote.
// Deliberately generous about what counts as a feature: shipping a minor
// where a patch would have done costs nothing, and the reverse hides a
// change inside a version number that promised not to have one.
const BREAKING = /\bBREAKING\b|\bbreaking change\b/i;
const FIXY = /^(fix|bug|hotfix|typo|docs?|test|chore|deps|revert|ci)\b|\bfix(es|ed)?\b/i;

function inferBump() {
  if (has("--major")) return "major";
  if (has("--minor")) return "minor";
  if (has("--patch")) return "patch";
  if (commits.some((c) => BREAKING.test(c.subject) || BREAKING.test(c.body))) return "major";
  if (commits.some((c) => !FIXY.test(c.subject))) return "minor";
  return "patch";
}

const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const [maj, min, pat] = pkg.version.split(".").map(Number);
const bump = inferBump();

// Before 1.0.0, semver says the minor is where breaking changes live: 0.x
// is "anything may change". Bumping to 1.0.0 is a statement about
// stability, and no script should make it on a maintainer's behalf.
const zeroVer = maj === 0;
const next =
  bump === "major"
    ? zeroVer
      ? `0.${min + 1}.0`
      : `${maj + 1}.0.0`
    : bump === "minor"
      ? zeroVer
        ? `0.${min + 1}.0`
        : `${maj}.${min + 1}.0`
      : `${maj}.${min}.${pat + 1}`;

if (bump === "major" && zeroVer) {
  console.log("note: a breaking change before 1.0.0 is a minor bump — 0.x means anything may change\n");
}

// ---------------------------------------------------------------- the entry
//
// Grouped by the `scope:` a subject already carries ("browser tool: …"),
// because that is how the person writing them was already thinking.

function scopeOf(subject) {
  const m = subject.match(/^([a-z0-9 ._/+-]{2,28}):\s+(.*)$/i);
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

console.log(`${pkg.name}  ${pkg.version} → ${next}   (${bump}, ${commits.length} commit${commits.length === 1 ? "" : "s"} since ${since ?? "the beginning"})\n`);
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
// makes the next `npm ci` disagree with the package it just built.
const lockPath = path.join(root, "package-lock.json");
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.version = next;
  if (lock.packages?.[""]) lock.packages[""].version = next;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
}

git("add", "CHANGELOG.md", "package.json", ...(fs.existsSync(lockPath) ? ["package-lock.json"] : []));
git("commit", "-m", `release ${next}`);
git("tag", "-a", `v${next}`, "-m", `${pkg.name} ${next}`);
console.log(`\ntagged v${next} — \`git push --follow-tags\` publishes it`);
