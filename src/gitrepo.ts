// A git repository per workspace — the platform as the remote.
//
//   git remote add foldrun https://app.foldrun.io/git/<tenant>/<workspace>.git
//   git push foldrun main          → deploys, commit on record
//   git clone …/<workspace>.git    → the workspace, with its whole history
//
// One bare repository per workspace on the data volume. Every change the
// platform makes — a dashboard save, a deploy, a deletion — is a commit into
// it, made with git's own plumbing against a scratch index so no working copy
// is ever kept. Every change a person makes is a push into it. So there is
// one history, it is real git, and anyone can take it away with `git clone`.
//
// This deliberately stops at being a remote. Pull requests, reviews and
// issues are a forge, which is a product; GitHub and GitLab remain a fine
// mirror for anyone who wants that on top.
//
// history.ts delegates here when a repository exists, so the History page,
// the per-file panel and Observe's eval attribution all read git without
// knowing it. The journal it kept before stays as the fallback for an install
// without a git binary.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { dataRoot } from "./paths.ts";
import type { DiffOp, Revision, RevisionFile, RevisionSummary } from "./history.ts";

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const safe = (v: string, what: string) => {
  if (!SAFE.test(v)) throw new Error(`illegal ${what}: ${v}`);
  return v;
};

/** Where a workspace's bare repository lives. `@library` is the account shelf. */
export function repoDir(tenant: string, scope: string): string {
  safe(tenant, "tenant");
  const name = scope === "@library" ? "_library" : safe(scope, "workspace");
  return path.join(dataRoot(), tenant, ".git", `${name}.git`);
}

let gitChecked: boolean | null = null;
/** Is there a git binary? Checked once; an install without one keeps the journal. */
export function gitAvailable(): boolean {
  if (gitChecked === null) {
    gitChecked = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  }
  return gitChecked;
}

function git(dir: string, args: string[], opts: { input?: string | Buffer; env?: Record<string, string> } = {}) {
  const r = spawnSync("git", ["--git-dir", dir, ...args], {
    input: opts.input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(r.stderr?.toString() ?? "").trim().slice(0, 500)}`);
  }
  return r.stdout.toString();
}

export function repoExists(tenant: string, scope: string): boolean {
  return fs.existsSync(path.join(repoDir(tenant, scope), "HEAD"));
}

/** Create the repository if it is not there. Idempotent. */
export function ensureRepo(tenant: string, scope: string): string {
  const dir = repoDir(tenant, scope);
  if (!fs.existsSync(path.join(dir, "HEAD"))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    spawnSync("git", ["init", "--bare", "--quiet", "--initial-branch=main", dir], { stdio: "ignore" });
    // Pushes over HTTP need this; it is the one config a bare remote wants.
    git(dir, ["config", "http.receivepack", "true"]);
  }
  installHooks(dir);
  return dir;
}

export function headSha(tenant: string, scope: string, ref = "refs/heads/main"): string | null {
  if (!repoExists(tenant, scope)) return null;
  const r = spawnSync("git", ["--git-dir", repoDir(tenant, scope), "rev-parse", "--verify", "--quiet", ref]);
  return r.status === 0 ? r.stdout.toString().trim() : null;
}

/**
 * Apply a change set as one commit on main, using plumbing against a scratch
 * index seeded from HEAD. No working copy, no checkout: each changed path is
 * hashed straight from its content into the object store.
 *
 * Returns the new commit, or null when the tree did not change.
 */
export function commitChanges(
  tenant: string,
  scope: string,
  files: RevisionFile[],
  meta: { by?: string; message?: string; at?: string } = {},
): string | null {
  const dir = ensureRepo(tenant, scope);
  const parent = headSha(tenant, scope);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-index-"));
  const index = path.join(scratch, "index");
  // update-index insists on a work tree even when every entry arrives as
  // --cacheinfo and nothing on disk is read. The scratch directory is one.
  const env = { GIT_INDEX_FILE: index, GIT_WORK_TREE: scratch };
  try {
    if (parent) git(dir, ["read-tree", parent], { env });
    for (const f of files) {
      if (f.after === null) {
        if (parent) git(dir, ["update-index", "--force-remove", "--", f.path], { env });
        continue;
      }
      const blob = git(dir, ["hash-object", "-w", "--stdin"], { input: f.after }).trim();
      // Executable where code lives, matching what the writers chmod on disk.
      const mode = /\.(py|sh|mjs|js|rb)$/.test(f.path) && /(^|\/)(scripts|tools)\//.test(f.path) ? "100755" : "100644";
      git(dir, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${f.path}`], { env });
    }
    const tree = git(dir, ["write-tree"], { env }).trim();
    if (parent && git(dir, ["rev-parse", `${parent}^{tree}`]).trim() === tree) return null;

    const who = meta.by ?? "system";
    const email = who.includes("@") ? who : `${who}@foldrun`;
    const name = who.includes("@") ? who.split("@")[0] : who;
    const date = meta.at ? new Date(meta.at).toISOString() : new Date().toISOString();
    const commit = git(
      dir,
      ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", meta.message ?? describe(files)],
      {
        env: {
          GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: "foldrun", GIT_COMMITTER_EMAIL: "platform@foldrun", GIT_COMMITTER_DATE: date,
        },
      },
    ).trim();
    git(dir, ["update-ref", "refs/heads/main", commit, ...(parent ? [parent] : [])]);
    return commit;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function describe(files: RevisionFile[]): string {
  if (files.length === 1) {
    const f = files[0];
    return `${f.before === null ? "created" : f.after === null ? "deleted" : "edited"} ${f.path}`;
  }
  return `changed ${files.length} files`;
}

// ------------------------------------------------------------------ reading

const SEP = "";

/** Commits on main, newest first, as the same summary the journal gave. */
export function listCommits(
  tenant: string,
  scope: string,
  opts: { forPath?: string; limit?: number; ref?: string } = {},
): RevisionSummary[] {
  if (!headSha(tenant, scope, opts.ref)) return [];
  const dir = repoDir(tenant, scope);
  const out = git(dir, [
    "log",
    opts.ref ?? "refs/heads/main",
    `--max-count=${opts.limit ?? 200}`,
    `--format=%H${SEP}%aI${SEP}%ae${SEP}%s`,
    "--name-only",
    ...(opts.forPath ? ["--", opts.forPath] : []),
  ]);
  const rows: RevisionSummary[] = [];
  let current: RevisionSummary | null = null;
  for (const line of out.split("\n")) {
    if (line.includes(SEP)) {
      const [id, at, by, message] = line.split(SEP);
      current = { id, at, by: by.endsWith("@foldrun") ? by.replace(/@foldrun$/, "") : by, message, commit: id, paths: [] };
      rows.push(current);
    } else if (line.trim() && current) {
      current.paths.push(line.trim());
    }
  }
  return rows;
}

/** One commit in full: every changed file with its before and after. */
export function readCommit(tenant: string, scope: string, sha: string, forPath?: string): Revision | null {
  if (!repoExists(tenant, scope) || !/^[0-9a-f]{4,40}$/.test(sha)) return null;
  const dir = repoDir(tenant, scope);
  const head = spawnSync("git", ["--git-dir", dir, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
  if (head.status !== 0) return null;
  const full = head.stdout.toString().trim();
  const [at, by, ...msg] = git(dir, ["log", "-1", `--format=%aI${SEP}%ae${SEP}%s`, full]).trim().split(SEP);
  const hasParent = spawnSync("git", ["--git-dir", dir, "rev-parse", "--verify", "--quiet", `${full}^`]).status === 0;
  const names = git(dir, [
    "diff-tree", "--no-commit-id", "--name-status", "-r", "--root", full,
    ...(forPath ? ["--", forPath] : []),
  ]);
  const files: RevisionFile[] = [];
  for (const line of names.split("\n").filter(Boolean)) {
    const [status, p] = line.split("\t");
    const before = status === "A" || !hasParent ? null : blob(dir, `${full}^`, p);
    const after = status === "D" ? null : blob(dir, full, p);
    files.push({ path: p, before, after });
  }
  return {
    id: full,
    at,
    by: by.endsWith("@foldrun") ? by.replace(/@foldrun$/, "") : by,
    message: msg.join(SEP),
    commit: full,
    files,
  };
}

function blob(dir: string, rev: string, p: string): string | null {
  const r = spawnSync("git", ["--git-dir", dir, "show", `${rev}:${p}`], { maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.toString() : null;
}

export interface RefInfo {
  name: string;
  sha: string;
  /** Commit subject and time, for a branch list that says what each is. */
  subject: string;
  at: string;
}

export function listRefs(tenant: string, scope: string, kind: "heads" | "tags"): RefInfo[] {
  if (!repoExists(tenant, scope)) return [];
  const out = git(repoDir(tenant, scope), [
    "for-each-ref", `refs/${kind}`, "--sort=-committerdate",
    `--format=%(refname:short)${SEP}%(objectname)${SEP}%(subject)${SEP}%(committerdate:iso-strict)`,
  ]);
  return out.split("\n").filter(Boolean).map((l) => {
    const [name, sha, subject, at] = l.split(SEP);
    return { name, sha, subject, at };
  });
}

/** The files at a commit, for a browser or a deploy. */
export function listTree(tenant: string, scope: string, ref = "refs/heads/main"): { path: string; mode: string }[] {
  if (!headSha(tenant, scope, ref)) return [];
  return git(repoDir(tenant, scope), ["ls-tree", "-r", "--format=%(objectmode) %(path)", ref])
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [mode, ...rest] = l.split(" ");
      return { mode, path: rest.join(" ") };
    });
}

export function readBlob(tenant: string, scope: string, ref: string, p: string): string | null {
  if (!repoExists(tenant, scope)) return null;
  return blob(repoDir(tenant, scope), ref, p);
}

/** The whole tree at a ref as deploy files — what a push turns into a workspace. */
export function filesAt(tenant: string, scope: string, ref: string): { path: string; content: string }[] {
  const dir = repoDir(tenant, scope);
  return listTree(tenant, scope, ref).flatMap((t) => {
    const content = blob(dir, ref, t.path);
    return content === null ? [] : [{ path: t.path, content }];
  });
}

/**
 * What a ref would change on main: every file that differs, with both sides.
 * The branch's own commits are `listCommits({ ref })`; this is the net
 * effect, which is what a reviewer reads.
 */
export function diffRefs(tenant: string, scope: string, base: string, head: string): RevisionFile[] {
  if (!headSha(tenant, scope, base) || !headSha(tenant, scope, head)) return [];
  const dir = repoDir(tenant, scope);
  const out = git(dir, ["diff", "--name-status", `${base}...${head}`]);
  return out.split("\n").filter(Boolean).map((line) => {
    const [status, p] = line.split("\t");
    return {
      path: p,
      before: status === "A" ? null : blob(dir, base, p),
      after: status === "D" ? null : blob(dir, head, p),
    };
  });
}

/**
 * Merge a branch into main and return the new main. A fast-forward when it
 * is one; otherwise a merge commit whose tree is the BRANCH's — the branch
 * is what the person reviewed and chose, and a three-way textual merge of
 * markdown with no one to resolve conflicts would deploy text nobody wrote.
 * Both parents are recorded, so history shows the merge for what it was.
 */
export function mergeBranch(
  tenant: string,
  scope: string,
  branch: string,
  meta: { by?: string } = {},
): { sha: string; fastForward: boolean } {
  const dir = repoDir(tenant, scope);
  const main = headSha(tenant, scope);
  const head = headSha(tenant, scope, `refs/heads/${safe(branch, "branch")}`);
  if (!head) throw new Error(`no branch "${branch}"`);
  if (!main) {
    git(dir, ["update-ref", "refs/heads/main", head]);
    return { sha: head, fastForward: true };
  }
  const isAncestor = spawnSync("git", ["--git-dir", dir, "merge-base", "--is-ancestor", main, head]).status === 0;
  if (isAncestor) {
    git(dir, ["update-ref", "refs/heads/main", head, main]);
    return { sha: head, fastForward: true };
  }
  const tree = git(dir, ["rev-parse", `${head}^{tree}`]).trim();
  const who = meta.by ?? "foldrun";
  const email = who.includes("@") ? who : `${who}@foldrun`;
  const name = who.includes("@") ? who.split("@")[0] : who;
  const date = new Date().toISOString();
  const sha = git(dir, ["commit-tree", tree, "-p", main, "-p", head, "-m", `merge ${branch} into main`], {
    env: {
      GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: "foldrun", GIT_COMMITTER_EMAIL: "platform@foldrun", GIT_COMMITTER_DATE: date,
    },
  }).trim();
  git(dir, ["update-ref", "refs/heads/main", sha, main]);
  return { sha, fastForward: false };
}

export function deleteBranch(tenant: string, scope: string, branch: string) {
  if (branch === "main") throw new Error("main is the default branch");
  git(repoDir(tenant, scope), ["update-ref", "-d", `refs/heads/${safe(branch, "branch")}`]);
}

/** Push main to another remote — a GitHub or GitLab mirror. Blocking; callers
 *  run it off the request path. The token never touches disk: it is in the
 *  URL for this one process and nowhere else. */
export function pushMirror(tenant: string, scope: string, url: string): { ok: boolean; detail: string } {
  if (!headSha(tenant, scope)) return { ok: false, detail: "nothing to push yet" };
  const r = spawnSync("git", ["--git-dir", repoDir(tenant, scope), "push", "--quiet", url, "+refs/heads/main:refs/heads/main"], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 60_000,
  });
  const detail = (r.stderr?.toString() ?? "").trim()
    // Never echo the URL back: it carries the token.
    .replaceAll(url, "<mirror>")
    .slice(0, 500);
  return { ok: r.status === 0, detail: r.status === 0 ? "pushed" : detail || "push failed" };
}

/**
 * Where the compiled pre-receive check is, found on disk rather than through
 * require.resolve — a bundler rewrites require.resolve("pkg") into a module
 * id, and the hook was once told to run a script called "51113". Searched
 * from the working directory upward: the monorepo layout, then an installed
 * package. Empty when there is no compiled check (a dev server on the source
 * tree), in which case a push is checked at deploy instead of refused — the
 * same rules, one step later.
 */
export function hookScriptPath(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    for (const rel of ["packages/core/dist/src/git-hook.js", "node_modules/@foldrun/core/dist/src/git-hook.js"]) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

/**
 * The pre-receive hook: a push that fails the deploy checks is refused with
 * the errors in the pusher's terminal, instead of accepted and then not
 * deployed. The hook shells out to node with the compiled check, so it runs
 * the same rules as a dashboard deploy; which node and which script are
 * passed in the environment by the HTTP route, because a hook inherits git's
 * environment and nothing else.
 */
export function installHooks(dir: string) {
  const hooks = path.join(dir, "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  const hook = path.join(hooks, "pre-receive");
  const script = `#!/bin/sh
# Installed by foldrun. Refuses a push to main whose tree fails the checks.
[ -n "$FOLDRUN_HOOK_NODE" ] && [ -n "$FOLDRUN_HOOK_SCRIPT" ] || exit 0
exec "$FOLDRUN_HOOK_NODE" "$FOLDRUN_HOOK_SCRIPT"
`;
  if (!fs.existsSync(hook) || fs.readFileSync(hook, "utf8") !== script) {
    fs.writeFileSync(hook, script, { mode: 0o755 });
  }
}

export { type DiffOp };
