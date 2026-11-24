/**
 * The walls for a run on a person's own machine (FOL-214): `foldrun code
 * --local` and, later, `foldrun run`. Commands the agent runs — the shell,
 * an MCP server it starts, what those start in turn — go through Anthropic's
 * sandbox-runtime (Apache-2.0): Seatbelt on macOS, bubblewrap + seccomp on
 * Linux. The engine's own file tools run in this process, so they check the
 * same roots here (canRead / canWrite) rather than in the OS.
 *
 * One policy everywhere:
 *   - write: the project folder and a private temp folder (plus the few the
 *     runtime itself keeps writable, named by writable()), never the git
 *     hooks or config that run code on the next git command — the project's
 *     repository's, core.hooksPath's, and every nested repository's;
 *   - read: everything but the person's credentials (DENY_READ);
 *   - network: only the sites listed, through the runtime's proxy — the
 *     command has no other way out. An MCP server over HTTP, which this
 *     process would reach itself, is not offered inside the walls.
 *
 * The programs that put the walls up are chosen by no one inside them. The
 * launcher is a fixed shell (LAUNCHER) started with a short list of plain
 * variables and a PATH that holds no folder a command may write; while the
 * walls are up this process's own PATH is that one too, because the runtime
 * starts its helpers (which, rg, socat, bwrap, log, npm) by name from it,
 * and the Linux helpers are also pinned to where they were found. The
 * command's own environment travels under other names (FOLDRUN_IN_*) and is
 * set again only inside, so nothing in it (LD_PRELOAD, BASH_ENV, a PATH into
 * the project) touches a program outside, and no value is on a command line.
 * Neither foldrun nor the runtime may be installed where a command can write.
 *
 * FAIL CLOSED: a backend that cannot start, a git question that cannot be
 * answered, or a probe that does not show every wall holding, is a refusal
 * with the reason and how to fix it — never a run without walls. Windows
 * without WSL2 is refused: the runtime's Windows backend is an alpha that
 * needs an elevated install.
 *
 * Known limits, said rather than hidden:
 *   - a hard link that already exists in the project to a file outside it
 *     is that file (on Linux a command can write through one; Read can read
 *     through one);
 *   - on Linux, a credential path that does not exist when a command is
 *     wrapped is not hidden from that command (bubblewrap masks what is
 *     there): a long-lived one, such as an MCP server, could read a
 *     credential file made after it started;
 *   - a repository a command creates below the project, and configures in
 *     that same command, is protected from the next command on (by the
 *     runtime's scan and the file tools' pattern), not before;
 *   - git's hooks, config and the programs its settings name are protected,
 *     but what an existing hook itself runs is project code (husky,
 *     lint-staged, `npm test` in a pre-commit): a change the agent made to
 *     it runs at the person's next git command, as any change to the
 *     project runs when they next run it. Review before committing;
 *   - a program setting that builds a file name at run time ($(…), eval)
 *     cannot be followed;
 *   - a long-lived process (an MCP server) runs under the rules it started
 *     with: it is stopped when any later launch, or its own next call,
 *     finds them changed, so its lifetime up to then counts as one command.
 *     On Linux everything a command starts lives in bubblewrap's own pid
 *     namespace and ends with it; on macOS a process that leaves its
 *     session (setsid, a daemon) is beyond what foldrun can find and end,
 *     and keeps the rules it started with until it exits.
 * The file tools write through a helper inside the walls, so the OS holds
 * their writes; they read through a descriptor checked after it is open.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Where a person's credentials live: never readable from inside. Paths
 *  under the home folder are written `~/…`, as the runtime expects. */
export const DENY_READ: readonly string[] = [
  "~/.ssh",
  "~/.aws",
  "~/.azure",
  "~/.config/gcloud",
  "~/.kube",
  "~/.docker/config.json",
  "~/.gnupg",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
  "~/.git-credentials",
  "~/.config/gh",
  "~/.foldrun",
  "~/.claude.json",
  "~/.claude/.credentials.json",
  "~/.codex",
  "~/Library/Keychains",
  "~/.password-store",
];

/** What the runtime keeps writable for every command on its own (its
 *  SANDBOX_OWN_WRITE_PATHS and home conveniences, 0.0.83): named by
 *  writable() so the person is told the truth. The file tools do not get these. */
const RUNTIME_OWN_WRITES = ["/tmp/claude", "~/.npm/_logs", "~/.claude/debug"];

/** The shell the walls are put up from: a fixed program, never a `bash`
 *  found on a PATH the project could have changed. */
export const LAUNCHER = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

/** How deep nested repositories are looked for (the runtime's own scan goes
 *  as deep), and how many folders: past either, the open is refused. */
const GIT_SEARCH_DEPTH = 10;
const GIT_SEARCH_DIRS = 100_000;

/** The variables the launcher itself starts with: plain ones a program
 *  needs, none that makes a program load or run something. */
const LAUNCHER_VARS = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM"];

/** What makes a program load a library, run a file or take options before
 *  its own work: kept out of this process's environment while the walls
 *  are up (the runtime's host helpers inherit it), set again inside. */
const LOADER_VARS = /^(LD_[A-Z_]+|DYLD_[A-Z_]+|BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|PERL5OPT|PERL5LIB|PYTHONSTARTUP|PYTHONPATH|RUBYOPT|GIT_EXEC_PATH|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|SSH_ASKPASS|BASH_FUNC_.*)$/;

/** Names a shell can export, less the ones bash keeps read-only. */
const EXPORTABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NOT_EXPORTED = new Set(["SHELLOPTS", "BASHOPTS", "BASH_VERSINFO", "EUID", "UID", "PPID"]);

export type SandboxBackend = "seatbelt" | "bubblewrap";

export interface LocalSandboxPolicy {
  /** The project folder: readable and writable. */
  cwd: string;
  /** More paths a command may not read, beside DENY_READ. */
  denyRead?: string[];
  /** Sites a command may reach (`api.example.com`, `*.example.com`). */
  sites: string[];
  /** Where package managers keep their downloads for this project: writable,
   *  and named to npm, yarn, pnpm, bun, pip, uv and go. One per project — a
   *  shared one would let one project's code change what another installs.
   *  Unset: a folder in the session's temp folder, gone when it closes. */
  cache?: string;
}

/** The variables that point package managers at the sandbox's cache (FOL-272:
 *  npm's own ~/.npm is not writable inside, so `npm install` and `npx` failed
 *  with a "sudo chown" message). */
export function packageCacheEnv(cache: string): Record<string, string> {
  return {
    npm_config_cache: path.join(cache, "npm"),
    YARN_CACHE_FOLDER: path.join(cache, "yarn"),
    npm_config_store_dir: path.join(cache, "pnpm"),
    BUN_INSTALL_CACHE_DIR: path.join(cache, "bun"),
    PIP_CACHE_DIR: path.join(cache, "pip"),
    UV_CACHE_DIR: path.join(cache, "uv"),
    GOCACHE: path.join(cache, "go-build"),
    GOMODCACHE: path.join(cache, "go-mod"),
  };
}

export interface LocalSandbox {
  backend: SandboxBackend;
  /** The private temp folder: a command's TMPDIR. */
  tmp: string;
  /** How to run `command` inside the walls with `env` as its environment:
   *  start LAUNCHER with `-c line` and exactly `env` (the launcher's own).
   *  Refuses once this handle is closed. */
  launch(command: string, env: Record<string, string | undefined>): Promise<{ line: string; env: Record<string, string>; token: string }>;
  /** Whether a process launched with `token` runs under the protections as
   *  they are now: found again, compared. */
  fresh(token: string): boolean;
  /** Told the new token whenever a launch finds the protections changed. */
  onChange(listener: (token: string) => void | Promise<void>): () => void;
  /** Whether the engine's own file tools may read / write this path (false
   *  for everything once this handle is closed). */
  canRead(file: string): boolean;
  canWrite(file: string): boolean;
  /** For the session's record and the CLI: what the walls do, in plain words. */
  describe(): string;
  /** Every folder a command may write to: the project, its temp folder, the package cache and the runtime's own. */
  writable(): string[];
  /** The package managers' cache folder (policy.cache, or one in the temp folder). */
  cache: string;
  /** Give this handle back; the walls come down when the last one is. */
  close(): Promise<void>;
}

export interface SandboxRefusal {
  refused: string;
  /** What the person can do about it, when there is something. */
  hint?: string;
}

export const isRefusal = (x: LocalSandbox | SandboxRefusal): x is SandboxRefusal => "refused" in x;

const home = () => os.homedir();
/** `~` and `~/…` as the home folder, joined as text: a `..` after it is
 *  left for the links on the way to decide. */
const expand = (p: string) => {
  if (p === "~") return home();
  if (p.startsWith("~/")) return `${home()}${path.sep}${p.slice(2)}`;
  // ~name/…: this person's own name is their home; another person's home
  // is not looked up, so a path written that way is refused.
  const m = /^~([A-Za-z0-9._-]+)(\/.*)?$/.exec(p);
  if (m) {
    const me = os.userInfo();
    if (m[1] === me.username) return `${me.homedir}${m[2] ?? ""}`;
    throw new Error(`${p} names another user's home folder, which foldrun does not look up`);
  }
  return p;
};
/** A path the runtime must take as the name it is, never as a pattern. */
const lit = (p: string) => ({ path: p, literal: true as const });

/** A path as the file system names it — links followed, and in its own
 *  case (realpathSync.native: on a case-insensitive Mac volume the plain
 *  realpath keeps whatever case it was given, so `~/.SSH` would not look
 *  like `~/.ssh`). A file that does not exist yet is judged by where it
 *  would land: its nearest existing parent, resolved, joined with the rest. */
export function realish(p: string): string {
  // Handed to realpath(3) as written: it takes `..` after a link the way
  // the kernel does, where path.resolve would drop `link/..` as text first.
  const given = path.isAbsolute(p) ? p : `${process.cwd()}${path.sep}${p}`;
  let dir = given;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest.reverse());
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return path.resolve(given);
      rest.push(path.basename(dir));
      dir = up;
    }
  }
}

/** Denies compare without case on macOS and Windows, whose usual volumes
 *  ignore it: a deny is never weaker for a spelling. */
const foldCase = (platform: NodeJS.Platform) => (s: string) => (platform === "darwin" || platform === "win32" ? s.toLowerCase() : s);

const within = (file: string, root: string) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);

/** `PATH` with every entry a command could have written removed (and every
 *  relative one): what the launcher may look programs up in. */
export function trustedPath(pathVar: string | undefined, writable: string[], platform: NodeJS.Platform = process.platform): string {
  const fold = foldCase(platform);
  const roots = writable.map((r) => fold(realish(r)));
  // Each kept by where it really is, so a link swapped later changes nothing.
  const kept = (pathVar ?? "")
    .split(path.delimiter)
    .filter((d) => path.isAbsolute(d))
    .map((d) => realish(d))
    .filter((d) => !roots.some((r) => overlaps(fold(d), r)));
  const out = [...new Set(kept)];
  return out.length ? out.join(path.delimiter) : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);
}

/** `rel` taken from `base` as text, the way git and the kernel take it:
 *  no `..` dropped before the links on the way are followed. */
const textJoin = (base: string, rel: string) => (path.isAbsolute(rel) ? rel : `${base}${path.sep}${rel}`);

/** Every link met on the way to `file`, resolved one component at a time
 *  (folders on the way too), and where it lands: each one a place a change
 *  could redirect it. A dangling end is where it would land. */
export function linkHops(file: string): string[] {
  const hops: string[] = [];
  const parts = (p: string) => p.split(path.sep).filter(Boolean);
  // Taken as the kernel takes it: `..` after a link is the link's target's
  // parent, so nothing is normalised before the links are followed.
  let todo = parts(path.isAbsolute(file) ? file : `${process.cwd()}${path.sep}${file}`);
  let cur: string = path.sep;
  for (let n = 0; todo.length && n < 40; ) {
    const c = todo.shift()!;
    if (c === ".") continue;
    if (c === "..") {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, c);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(next);
    } catch {
      hops.push(path.join(next, ...todo));
      return hops;
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    n++;
    hops.push(next);
    const target = fs.readlinkSync(next);
    todo = [...parts(target), ...todo];
    if (path.isAbsolute(target)) cur = path.sep;
  }
  hops.push(cur);
  return hops;
}

/** Whether every step on the way to `file` — each folder, each link and
 *  where it points, resolved one component at a time — lies outside the
 *  folders a command may write: any of them inside could be changed later. */
export function chainOutside(file: string, roots: string[], platform: NodeJS.Platform = process.platform): boolean {
  const fold = foldCase(platform);
  const rs = roots.map((r) => fold(realish(r)));
  const parts = (p: string) => p.split(path.sep).filter(Boolean);
  let todo = parts(path.isAbsolute(file) ? file : `${process.cwd()}${path.sep}${file}`);
  let cur: string = path.sep;
  for (let hops = 0; todo.length; ) {
    const c = todo.shift()!;
    if (c === ".") continue;
    if (c === "..") {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, c);
    if (rs.some((r) => within(fold(next), r))) return false;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(next);
    } catch {
      return false; // not there: whatever appears there later is unknown
    }
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    if (++hops > 40) return false;
    const target = fs.readlinkSync(next);
    todo = [...parts(target), ...todo];
    if (path.isAbsolute(target)) cur = path.sep;
  }
  return true;
}

/** A program found on a trusted PATH, as the file it really is, when that
 *  file and every link to it lie outside `roots`; else null. */
function which(program: string, pathVar: string, roots: string[] = []): string | null {
  for (const dir of pathVar.split(path.delimiter)) {
    const full = path.join(dir, program);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (!fs.statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    return chainOutside(full, roots) ? fs.realpathSync.native(full) : null;
  }
  return null;
}

/** The programs this process starts by name while the walls are up: the
 *  runtime's helpers, git, and what npm needs to answer the runtime. */
const HOST_HELPERS = ["which", "env", "git", "log", "npm", "node", "rg", "bwrap", "socat", "sandbox-exec", "cat", "sh", "bash"];

/**
 * A folder only this process writes, holding a link to the real file of
 * each helper the person's PATH would run (first found, as exec finds it):
 * while the walls are up it is this process's whole PATH, so no lookup by
 * name ever sees a folder, a link or a file a command could change. A
 * helper whose real file lies in such a folder is a refusal.
 */
export function helperFolder(pathVar: string | undefined, roots: string[], platform: NodeJS.Platform = process.platform): { dir: string } | { refused: string } {
  const fold = foldCase(platform);
  const rs = roots.map((r) => fold(realish(r)));
  const inside = (real: string) => rs.some((r) => within(fold(real), r));
  for (const fixed of [LAUNCHER, "/bin/cat", process.execPath]) {
    if (!chainOutside(fixed, roots, platform)) return { refused: `${fixed} is, or leads to, a file a command could change` };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-bin-"));
  if (inside(realish(dir))) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { refused: "no folder outside the project for foldrun's own helpers" };
  }
  const dirs = (pathVar ?? "").split(path.delimiter).filter((d) => path.isAbsolute(d));
  for (const program of HOST_HELPERS) {
    for (const d of dirs) {
      const full = path.join(d, program);
      let real: string;
      try {
        if (!fs.statSync(full).isFile()) continue;
        fs.accessSync(full, fs.constants.X_OK);
        real = fs.realpathSync.native(full);
      } catch {
        continue;
      }
      if (inside(real)) {
        fs.rmSync(dir, { recursive: true, force: true });
        return { refused: `${full} leads to ${real}, a file a command could change, and foldrun would run it outside the walls` };
      }
      fs.symlinkSync(real, path.join(dir, program));
      break;
    }
  }
  return { dir: realish(dir) };
}

/**
 * The git paths that run code on a later git command: the hooks (or the
 * folder core.hooksPath names) and every config file git reads (config,
 * config.worktree, included files) of the repository the project is in and
 * of every repository nested below it. Asked of git on the host, with a git
 * found on a trusted PATH. A question git cannot answer, a repository with
 * no git to ask, or a project too large to search, is an error, never an
 * empty answer: a hooks folder dropped by a failed lookup would be writable.
 */
export function gitProtected(cwd: string, pathVar = trustedPath(process.env.PATH, [cwd]), hostEnv: NodeJS.ProcessEnv = process.env, writeRoots: string[] = [cwd]): string[] {
  const out: string[] = [];
  const fold = foldCase(process.platform);
  const repos = [cwd, ...nestedRepos(cwd)];
  const inRepo = repos.length > 1 || hasGitAbove(cwd) || looksBare(cwd);
  // A selector in the environment would point every question below at one
  // repository, whatever folder it is asked from.
  const selector = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CONFIG_PARAMETERS"].find((k) => hostEnv[k]);
  if (selector) throw new Error(`${selector} is set in this shell, so git would answer for that repository instead of the project's — unset it to use the local sandbox`);
  // A .git that is a file names the git folder: it is protected as well.
  for (const r of repos) for (const f of [".git", ...["hooks", "config", "config.worktree", "commondir", "gitdir"].map((x) => path.join(".git", x))]) out.push(path.join(r, f));
  const gitBin = which("git", pathVar, [cwd]);
  // Without git nothing can say which config files and hooks a later git
  // command would use (its includes, its global file): refused.
  const spellings = (p: string) => {
    const hops = linkHops(p);
    return [path.resolve(p), ...hops, realish(hops[hops.length - 1]!)];
  };
  if (!gitBin) throw new Error(inRepo ? "this project is a git repository, and no git was found to ask where its hooks and config are" : "no git was found to read git's settings (its config files may name files in the project)");
  const git = (dir: string, args: string[]) => {
    // The person's own git settings (XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL…)
    // decide what the next git command reads: ask with those, and nothing
    // that makes git load or run anything else.
    const r = spawnSync(gitBin, ["-C", dir, ...args], { encoding: "utf8", timeout: 10_000, env: gitEnv(hostEnv, pathVar) });
    return { status: r.status, out: r.stdout ?? "", err: (r.stderr || r.error?.message || "").trim().split("\n")[0] ?? "" };
  };
  const must = (dir: string, args: string[], what: string) => {
    const r = git(dir, args);
    if (r.status !== 0) throw new Error(`git could not say ${what} for ${dir}: ${r.err || `exit ${r.status}`}`);
    return r.out.trim();
  };
  for (const dir of repos) {
    const probe = git(dir, ["rev-parse", "--is-bare-repository"]);
    // Only the project folder may be no repository (a nested one has a .git,
    // or is a bare one); its global and system config are still read below.
    let isRepo = true;
    if (probe.status !== 0) {
      if (/not a git repository/i.test(probe.err) && dir === cwd && !hasGitAbove(cwd) && !looksBare(cwd)) isRepo = false;
      else throw new Error(`git could not read the repository at ${dir}: ${probe.err || `exit ${probe.status}`}`);
    }
    const bare = isRepo && probe.out.trim() === "true";
    const gitDirs: string[] = [];
    if (isRepo) {
      for (const which of ["--git-dir", "--git-common-dir"]) {
        const d = must(dir, ["rev-parse", "--path-format=absolute", which], "the git folder");
        gitDirs.push(d);
        for (const f of ["hooks", "config", "config.worktree", "commondir", "gitdir"]) out.push(path.join(d, f));
      }
    }
    const top = !isRepo ? dir : bare ? gitDirs[0]! : must(dir, ["rev-parse", "--show-toplevel"], "the top folder");
    // A nested repository must answer as itself, not as the one around it.
    if (isRepo && dir !== cwd && fold(realish(bare ? gitDirs[0]! : top)) !== fold(realish(dir))) throw new Error(`git answered for ${top} when asked about ${dir}`);
    const hookBases = [top, ...gitDirs];
    const hooksAt = (h: string) => {
      const x = expand(h);
      // A relative one is taken from where git runs a hook: the work tree
      // for most, the git folder for those a push runs. Both.
      for (const d of path.isAbsolute(x) ? [x] : hookBases.map((b) => `${b}${path.sep}${x}`)) {
        out.push(d, ...linkHops(d));
        hookEntries(d);
      }
    };
    // Each hook that is a link: every hop to the script it runs.
    const hookEntries = (d: string) => {
      let names: string[];
      try {
        names = fs.readdirSync(d);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return;
        throw new Error(`the hooks folder ${d} could not be listed (${code ?? String(err)})`);
      }
      for (const n of names) out.push(`${d}${path.sep}${n}`, ...linkHops(`${d}${path.sep}${n}`));
    };
    for (const d of gitDirs) hookEntries(path.join(d, "hooks"));
    // `config --get` exits 1 for "not set": that is an answer.
    const hooks = git(dir, ["config", "--type=path", "--get", "core.hooksPath"]);
    if (hooks.status === 0 && hooks.out.trim()) hooksAt(hooks.out.trim());
    else if (hooks.status !== 1) throw new Error(`git could not say core.hooksPath for ${dir}: ${hooks.err || `exit ${hooks.status}`}`);
    // Every file git took its settings from, then each one read on its own
    // with every include it names followed — conditional ones too, active
    // or not, there or not yet: what they say could apply tomorrow.
    const origins = git(dir, ["config", "--list", "--show-origin", "--name-only", "-z"]);
    if (origins.status !== 0) throw new Error(`git could not list the config files of ${dir}: ${origins.err || `exit ${origins.status}`}`);
    const files = new Set<string>();
    const parts = origins.out.split("\0");
    for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]!.startsWith("file:")) files.add(textJoin(dir, expand(parts[i]!.slice(5))));
    for (const d of gitDirs) for (const f of ["config", "config.worktree"]) files.add(path.join(d, f));
    // The global and system files wherever this shell says they are, there
    // or not, empty or not: they apply to every later git command.
    for (const f of [hostEnv.GIT_CONFIG_GLOBAL, hostEnv.GIT_CONFIG_SYSTEM, path.join(hostEnv.XDG_CONFIG_HOME || path.join(home(), ".config"), "git", "config"), path.join(home(), ".gitconfig")]) {
      if (f) files.add(textJoin(dir, expand(f)));
    }
    for (const v of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) {
      const r = git(dir, ["var", v]);
      if (r.status === 0) for (const f of r.out.split("\n").map((x) => x.trim()).filter(Boolean)) files.add(textJoin(dir, expand(f)));
    }
    const queue = [...files];
    // The person's PATH as their own git will have it ('' and '.' are the
    // folder git runs in).
    // And git's own folder of programs (git-<name>): where this shell's
    // GIT_EXEC_PATH says, and where git says it is.
    const execPath = git(dir, ["--exec-path"]);
    const personDirs = [...(hostEnv.PATH ?? "").split(path.delimiter), hostEnv.GIT_EXEC_PATH ?? "", execPath.status === 0 ? execPath.out.trim() : ""]
      .map((d, i, all) => (d === "" && i >= all.length - 2 ? null : d === "" || d === "." ? top : textJoin(top, d)))
      .filter((d): d is string => d !== null);
    const rootsF = writeRoots.map((r) => fold(realish(r)));
    const inRoots = (x: string) => rootsF.some((r) => within(x, r));
    const protectWord = (key: string, x: string) => {
      const bare = !x.includes("/");
      // A bare name is a program looked up on the person's PATH: in each
      // folder of it a command may write, that name is theirs to plant.
      const viaPath = bare ? personDirs.map((d) => `${d}${path.sep}${x}`) : [];
      for (const at of [...(path.isAbsolute(x) ? [x] : hookBases.map((b) => `${b}${path.sep}${x}`)), ...viaPath]) {
        // In a writable folder by its name, by where it leads, or by a
        // link on the way: each of those can be swapped.
        const hops = linkHops(at);
        if (!hops.some((h) => inRoots(fold(h))) && !inRoots(fold(path.resolve(at)))) continue;
        if (/[*?[]/.test(x)) throw new Error(`the git setting ${key} names files in the project by a pattern (${x}), and which ones it runs cannot be told`);
        out.push(at, ...hops);
      }
    };
    const consider = (key: string, value: string, from: string, rawKey = key): void => {
      if (/^include(if\..*)?\.path$/.test(key) && value) {
        const t = expand(value);
        const target = textJoin(from, t);
        if (!files.has(target)) {
          files.add(target);
          queue.push(target);
        }
      } else if (key === "core.hookspath" && value) hooksAt(value);
      else if (PROGRAM_KEY.test(key)) {
        // A setting that runs a program: every word of it, as a file in the
        // work tree or a git folder, is code a later git command may run on
        // the host. Variables are taken from this shell first.
        // The words as a shell reads them (quotes, escapes, variables from
        // this shell, expanded only where the shell would), and crude splits
        // of the raw and the expanded text besides, each quoted group whole:
        // a name is protected in every spelling it could be read in.
        // An alias's leading ! is git's, not part of the command.
        const raw = value;
        value = value.replace(/^\s*!/, "");
        const expanded = value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_m, n: string) => hostEnv[n] ?? "");
        const crude = (t: string) => t.split(/[\s|;&<>()`'"]+/);
        const quoted = [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? "");
        const all = [...shellWords(value, hostEnv), ...crude(value), ...crude(expanded), ...quoted].filter(Boolean);
        // `NAME=value prog`: the value may be a path too; the whole word stays.
        // The whole value too: some settings are one literal program path
        // (GIT_SSH, gpg.program), spaces and all.
        const words = [...all, raw, value, value.trim(), ...all.filter((w) => w.includes("=")).map((w) => w.slice(w.indexOf("=") + 1))].filter(Boolean);
        // A helper named without a path is git-credential-<name>; an alias
        // that is not a shell command runs git-<name> when it is no builtin.
        const first = shellWords(value, hostEnv)[0];
        if (first && !first.includes("/") && !raw.trimStart().startsWith("!")) {
          if (/^credential(\..+)?\.helper$/.test(key)) words.push(`git-credential-${first}`);
          if (key.startsWith("alias.")) words.push(`git-${first}`);
        }
        // Each word as written (a quoted ~ is a folder named ~) and with ~
        // taken as home (an unquoted one).
        for (const x of [...new Set(words.flatMap((w) => [w, expand(w)]))]) protectWord(key, x);
      }
      // A remote helper: git runs git-remote-<transport>, found by name.
      const helper = remoteHelper(rawKey, value);
      if (helper) protectWord(key, `git-remote-${helper}`);
    };
    // Settings given in this shell's environment count as a file's do.
    const count = Number(hostEnv.GIT_CONFIG_COUNT ?? 0);
    const envPathKey = /^(include(if\..*)?\.path|core\.hookspath)$/i;
    for (let i = 0; i < (Number.isInteger(count) ? count : 0); i++) {
      const k = hostEnv[`GIT_CONFIG_KEY_${i}`];
      if (k && !envPathKey.test(k)) consider(k.toLowerCase(), hostEnv[`GIT_CONFIG_VALUE_${i}`] ?? "", dir, k);
    }
    // Those path settings as git expands them, from every scope (the
    // environment's "command line" one included).
    const typedAll = git(dir, ["config", "--show-origin", "--type=path", "-z", "--get-regexp", "^(include(if\\..*)?\\.path|core\\.hookspath)$"]);
    if (typedAll.status !== 0 && typedAll.status !== 1) throw new Error(`git could not expand its path settings for ${dir}: ${typedAll.err || `exit ${typedAll.status}`}`);
    if (typedAll.status === 0) {
      const q = typedAll.out.split("\0");
      for (let i = 0; i + 1 < q.length; i += 2) {
        if (!q[i]!.startsWith("command line:")) continue; // files are read below
        const entry = q[i + 1]!;
        const nl = entry.indexOf("\n");
        consider((nl < 0 ? entry : entry.slice(0, nl)).toLowerCase(), nl < 0 ? "" : entry.slice(nl + 1), dir);
      }
    }
    // Programs this shell's environment hands git (or what git starts).
    for (const k of ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PAGER", "GIT_EXTERNAL_DIFF", "GIT_PROXY_COMMAND", "EDITOR", "VISUAL", "PAGER"]) {
      const v = hostEnv[k];
      if (v) consider("core.pager", v, top);
    }
    while (queue.length) {
      const f = queue.shift()!;
      out.push(f, ...linkHops(f));
      if (!fs.existsSync(f)) continue;
      const r = git(dir, ["config", "-f", f, "--list", "-z"]);
      if (r.status !== 0) throw new Error(`git could not read ${f}: ${r.err || `exit ${r.status}`}`);
      const pathKey = /^(include(if\..*)?\.path|core\.hookspath)$/;
      for (const entry of r.out.split("\0")) {
        if (!entry) continue;
        const nl = entry.indexOf("\n");
        const rawKey = nl < 0 ? entry : entry.slice(0, nl);
        const key = rawKey.toLowerCase();
        if (pathKey.test(key)) continue; // below, as git expands them
        consider(key, nl < 0 ? "" : entry.slice(nl + 1), path.dirname(f), rawKey);
      }
      // Include and hooks paths as git itself expands them (~, ~user,
      // %(prefix)/): its answer, or a refusal when it cannot give one.
      const typed = git(dir, ["config", "-f", f, "--type=path", "-z", "--get-regexp", "^(include(if\\..*)?\\.path|core\\.hookspath)$"]);
      if (typed.status !== 0 && typed.status !== 1) throw new Error(`git could not expand the paths in ${f}: ${typed.err || `exit ${typed.status}`}`);
      if (typed.status === 0) {
        for (const entry of typed.out.split("\0")) {
          if (!entry) continue;
          const nl = entry.indexOf("\n");
          consider((nl < 0 ? entry : entry.slice(0, nl)).toLowerCase(), nl < 0 ? "" : entry.slice(nl + 1), path.dirname(f));
        }
      }
    }
  }
  // Each by the name git uses, by every link on the way and by where it
  // lands as the kernel walks it (`..` after a link included).
  return [...new Set(out.flatMap(spellings))];
}

/** What git needs to answer about its config, from the person's
 *  environment: where config lives and which repository, never a variable
 *  that makes a program load a library or run a file. */
const GIT_VARS = /^(HOME|LANG|LC_ALL|XDG_CONFIG_HOME|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG_PARAMETERS|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM)$/;
function gitEnv(from: NodeJS.ProcessEnv, pathVar: string): NodeJS.ProcessEnv {
  const out: Record<string, string> = { PATH: pathVar };
  for (const [k, v] of Object.entries(from)) if (typeof v === "string" && GIT_VARS.test(k)) out[k] = v;
  return out as NodeJS.ProcessEnv;
}

/** A shell line's words, as the shell reads them: quotes and backslash
 *  escapes taken, `$NAME` / `${NAME}` taken from `env` outside single
 *  quotes, split at blanks and the shell's operators. */
export function shellWords(t: string, env: Record<string, string | undefined> = {}): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  const variable = (i: number): [string, number] | null => {
    const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(t.slice(i));
    return m ? [env[m[1] ?? m[2]!] ?? "", m[0].length] : null;
  };
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
      continue;
    }
    if (c === "$") {
      const v = variable(i);
      if (v) {
        cur += v[0];
        i += v[1] - 1;
        continue;
      }
    }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === "\\" && i + 1 < t.length) cur += t[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === "\\" && i + 1 < t.length) cur += t[++i];
    else if (/[\s|;&<>()`]/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** The transport a remote setting makes git run git-remote-<it> for, or
 *  null: `remote.<n>.vcs`, a `<transport>::address` URL, a scheme git does
 *  not speak itself, and the same in a `url.<base>.insteadOf` base. */
export function remoteHelper(key: string, value: string): string | null {
  // Section and variable names ignore case; a subsection (the rewrite
  // base) and the transport keep theirs, as git keeps them.
  if (/^remote\..+\.vcs$/i.test(key)) return value.trim() || null;
  let url: string | null = null;
  if (/^remote\..+\.(url|pushurl)$/i.test(key)) url = value;
  const rewrite = /^url\.(.+)\.(insteadof|pushinsteadof)$/i.exec(key);
  if (rewrite) url = rewrite[1]!;
  if (!url) return null;
  const helper = /^([A-Za-z][A-Za-z0-9+.-]*)::/.exec(url);
  if (helper) return helper[1]!;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url);
  if (scheme && !["ssh", "git", "file", "git+ssh", "ssh+git"].includes(scheme[1]!.toLowerCase())) return scheme[1]!;
  return null;
}

/** Settings whose value git runs as a program (or a hook folder). */
const PROGRAM_KEY =
  /(command|cmd|program|helper|driver|textconv|editor|pager|askpass|hook|proxy|process|clean|smudge|fsmonitor|difffilter|browser|external|variant|receivepack|uploadpack|smtpserver|httpd)$|^submodule\..+\.update$|^(core\.(fsmonitor|pager|editor|sshcommand|askpass|gitproxy)|sequence\.editor|diff\.external|diff\..+\.(textconv|command)|merge\..+\.driver|filter\..+\.(clean|smudge|process)|credential(\..+)?\.helper|gpg(\..+)?\.program|alias\..+|uploadpack\.packobjectshook|interactive\.difffilter|pager\..+|web\.browser|browser\..+\.(cmd|path)|man\..+\.(cmd|path)|(merge|diff)tool\..+\.(cmd|path))$/;

/** A bare repository: HEAD, objects/ and refs/ with no work tree. */
function looksBare(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "HEAD")).isFile() && fs.statSync(path.join(dir, "objects")).isDirectory() && fs.statSync(path.join(dir, "refs")).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `dir` or a folder above it holds a `.git`. */
function hasGitAbove(dir: string): boolean {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
}

/** Folders below `cwd` that hold a repository of their own (a `.git`).
 *  Links are not followed. A folder that cannot be read, or a project past
 *  the depth or size limit, is an error: a repository missed is a hooks
 *  folder left writable. */
function nestedRepos(cwd: string): string[] {
  const found: string[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: cwd, depth: 0 }];
  let seen = 0;
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    if (++seen > GIT_SEARCH_DIRS) throw new Error(`the project has more than ${GIT_SEARCH_DIRS} folders to search for nested git repositories`);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`${dir} could not be searched for nested git repositories (${(err as NodeJS.ErrnoException).code ?? String(err)})`);
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === ".git") continue;
      const sub = path.join(dir, e.name);
      if (fs.existsSync(path.join(sub, ".git")) || looksBare(sub)) found.push(sub);
      if (depth + 1 >= GIT_SEARCH_DEPTH) {
        if (fs.readdirSync(sub, { withFileTypes: true }).some((x) => x.isDirectory())) throw new Error(`the project's folders go deeper than ${GIT_SEARCH_DEPTH} levels (${sub})`);
        continue;
      }
      stack.push({ dir: sub, depth: depth + 1 });
    }
  }
  return found;
}

/** A `.git/hooks`, `.git/config` or `.git/config.worktree` anywhere below:
 *  a repository made later. */
const NESTED_GIT = new RegExp(`(^|\\${path.sep})\\.git\\${path.sep}(hooks(\\${path.sep}|$)|config$|config\\.worktree$|commondir$)`, "i");

/** The in-process half of the policy: what the file tools may touch. Pure
 *  but for the paths it is given, so it is tested without a sandbox. */
export function fileRules(policy: LocalSandboxPolicy, tmp: string, protectedWrites: string[] = [], platform: NodeJS.Platform = process.platform) {
  const fold = foldCase(platform);
  const writable = [policy.cwd, tmp].map(realish);
  // Each deny by the name it was given and by where it leads today: a link
  // there now, replaced later by the real file, stays denied.
  const given = [...DENY_READ, ...(policy.denyRead ?? [])].map((p) => path.resolve(expand(p)));
  const denied = [...new Set([...given, ...given.map((p) => realish(p))].map(fold))];
  const noWrite = [...new Set([...protectedWrites.map((p) => path.resolve(p)), ...protectedWrites.map((p) => realish(p))].map(fold))];
  return {
    canRead: (file: string) => {
      const names = [fold(path.resolve(file)), fold(realish(file))];
      return !names.some((f) => denied.some((d) => within(f, d)));
    },
    canWrite: (file: string) => {
      const real = realish(file);
      const names = [fold(path.resolve(file)), fold(real)];
      if (names.some((f) => denied.some((d) => within(f, d)))) return false;
      if (names.some((f) => noWrite.some((d) => within(f, d)))) return false;
      if (NESTED_GIT.test(real)) return false;
      return writable.some((root) => within(real, root));
    },
  };
}

/** Ubuntu 24.04+ restricts unprivileged user namespaces through AppArmor,
 *  and bubblewrap then cannot start. */
export function appArmorRestrictsUserns(read = (f: string) => fs.readFileSync(f, "utf8")): boolean {
  try {
    return read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").trim() === "1";
  } catch {
    return false;
  }
}

/** The fix for that block. Never "turn the restriction off". */
export const APPARMOR_HINT =
  "Ubuntu restricts unprivileged user namespaces, so bubblewrap cannot start. Allow bubblewrap alone with the profile Ubuntu ships: " +
  "sudo cp /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/ && sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict";

/** How to install what the backend needs, per OS. */
function installHint(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Install ripgrep: brew install ripgrep";
  return "Install bubblewrap, socat and ripgrep: sudo apt-get install bubblewrap socat ripgrep (dnf / pacman: the same names)";
}

/** A process and everything it started, the root first. */
export function treePids(pid: number): number[] {
  const table = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const kids = new Map<number, number[]>();
  for (const line of (table.stdout ?? "").split("\n")) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!p || pp === undefined || Number.isNaN(pp)) continue;
    kids.set(pp, [...(kids.get(pp) ?? []), p]);
  }
  const all: number[] = [];
  const walk = (p: number) => {
    all.push(p);
    for (const c of kids.get(p) ?? []) walk(c);
  };
  walk(pid);
  return all;
}

/** End a process and every process below it (SIGKILL), found from the
 *  process table: a server's children do not outlive it. */
export function killTree(pid: number): void {
  const all = treePids(pid);
  for (const p of all.reverse()) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

/** One word for a shell, single-quoted. */
export const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The environment the probe starts from: a program needs these, and none
 *  of them is a secret. */
export function bareEnv(from: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "SHELL"]) if (typeof from[k] === "string") out[k] = from[k]!;
  return { ...out, ...extra };
}

type Runtime = typeof import("@anthropic-ai/sandbox-runtime");

/** Run a wrapped line, its output. Async: the runtime's proxy answers from
 *  this process, so a synchronous child would wait on a proxy that cannot. */
function runLine(line: string, cwd: string, env: Record<string, string>, ms = 30_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) =>
    execFile(LAUNCHER, ["-c", line], { cwd, env: env as NodeJS.ProcessEnv, timeout: ms, encoding: "utf8" }, (e, out, err) =>
      resolve({ code: e ? (typeof (e as { code?: unknown }).code === "number" ? (e as { code: number }).code : null) : 0, out: String(out), err: String(err || (e ? e.message : "")).trim() }),
    ),
  );
}

/** Where a module's file lives, or null. */
function moduleFile(spec: string): string | null {
  try {
    return fileURLToPath(import.meta.resolve(spec));
  } catch {
    return null;
  }
}

/** The folder of the package a file belongs to: the nearest one above it
 *  with a package.json (named `name`, when given). */
function packageRoot(file: string, name?: string): string {
  for (let d = path.dirname(realish(file)); ; d = path.dirname(d)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")) as { name?: string };
      if (!name || pkg.name === name) return d;
    } catch {
      /* none here */
    }
    if (path.dirname(d) === d) return path.dirname(realish(file));
  }
}

/** The code this process runs to keep the walls: the runtime, foldrun's
 *  core, the program started (the CLI) and node itself. */
function installTrees(): { what: string; dir: string }[] {
  const out: { what: string; dir: string }[] = [];
  const srt = moduleFile("@anthropic-ai/sandbox-runtime");
  if (srt) out.push({ what: "the sandbox runtime", dir: packageRoot(srt, "@anthropic-ai/sandbox-runtime") });
  out.push({ what: "foldrun", dir: packageRoot(fileURLToPath(import.meta.url), "@foldrun/core") });
  if (process.argv[1]) out.push({ what: "the program running foldrun", dir: packageRoot(process.argv[1]) });
  out.push({ what: "node", dir: path.dirname(path.dirname(realish(process.execPath))) });
  return out;
}

/** The one set of walls this process has up, shared by its handles. */
interface Walls {
  key: string;
  gen: number;
  users: number;
  down: boolean;
  wrapRaw(command: string): Promise<{ line: string; token: string }>;
  fingerprint(): string;
  listeners: Set<(token: string) => void | Promise<void>>;
  last: string;
  /** Discovery, comparison and the ending of stale processes, one launch
   *  at a time: none can pass a revocation still under way. */
  gate: Promise<unknown>;
  hostEnv: Record<string, string>;
  /** This process's PATH before the walls put the helper folder there. */
  personPath: string | undefined;
  rules: { canRead(f: string): boolean; canWrite(f: string): boolean };
  backend: SandboxBackend;
  tmp: string;
  describe: string;
  writable: string[];
  cache: string;
  teardown(): Promise<void>;
}
let walls: Walls | null = null;
let generation = 0;
/** Opens and teardowns, one at a time: the runtime is one per process. */
let queue: Promise<unknown> = Promise.resolve();
const inQueue = <T>(job: () => Promise<T>): Promise<T> => {
  const next = queue.then(job);
  queue = next.catch(() => undefined);
  return next;
};

/**
 * A command's environment carried past the launcher: each variable rides
 * as FOLDRUN_IN_<name> (only names are on the line, never values) and is
 * set again inside — PATH always, the rest where the runtime has not set
 * its own (its proxy, its temp folder).
 */
export function carry(env: Record<string, string | undefined>): { inner: string; outer: Record<string, string> } {
  const outer: Record<string, string> = {};
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string" || !EXPORTABLE.test(k) || NOT_EXPORTED.has(k) || k.startsWith("FOLDRUN_IN_")) continue;
    outer[`FOLDRUN_IN_${k}`] = v;
    lines.push(k === "PATH" ? `export PATH="$FOLDRUN_IN_PATH"` : `[ -n "\${${k}+x}" ] || export ${k}="$FOLDRUN_IN_${k}"`);
  }
  if (!lines.length) return { inner: "", outer };
  lines.push(`unset ${Object.keys(outer).join(" ")}`);
  return { inner: lines.join("\n"), outer };
}

/** A handle of its own for each open: closing it revokes it alone. */
function handleOf(w: Walls): LocalSandbox {
  let released = false;
  const live = () => !released && !w.down;
  return {
    backend: w.backend,
    tmp: w.tmp,
    cache: w.cache,
    launch: async (command, env) => {
      if (!live()) throw new Error("the sandbox is closed");
      const gen = w.gen;
      // An environment built from this process after the walls went up
      // has the helper folder for PATH: the person's own goes inside.
      // Package managers keep their downloads in the sandbox's cache: their
      // usual folders in the home are not writable inside.
      const withCache = { ...env, ...packageCacheEnv(w.cache) };
      const { inner, outer } = carry(withCache.PATH === w.hostEnv.PATH ? { ...withCache, PATH: w.personPath } : withCache);
      const { line, token } = await w.wrapRaw(inner ? `${inner}\n${command}` : command);
      // Made under this handle's walls, still up: a line from a later
      // policy, or for a handle given back meanwhile, is not handed out.
      if (!live() || w.gen !== gen || walls !== w) throw new Error("the sandbox closed while the command was being wrapped");
      if (!line || typeof line !== "string") throw new Error("the sandbox returned no command line");
      return { line, env: { ...w.hostEnv, ...outer }, token };
    },
    onChange: (listener) => {
      w.listeners.add(listener);
      return () => w.listeners.delete(listener);
    },
    fresh: (token) => {
      if (!live()) return false;
      try {
        return w.fingerprint() === token;
      } catch {
        return false;
      }
    },
    canRead: (file) => live() && w.rules.canRead(file),
    canWrite: (file) => live() && w.rules.canWrite(file),
    describe: () => w.describe,
    writable: () => [...w.writable],
    close: async () => {
      if (released) return;
      released = true;
      if (--w.users === 0) await inQueue(() => w.teardown());
    },
  };
}

/**
 * Start the walls for one session, or say why they cannot be had. The
 * runtime is one per process: a second open with the same policy gets a
 * handle of its own on the same walls (they come down when the last handle
 * is closed); one with another policy is refused while they are up.
 */
export function openLocalSandbox(
  policy: LocalSandboxPolicy,
  opts: { platform?: NodeJS.Platform; load?: () => Promise<Runtime> } = {},
): Promise<LocalSandbox | SandboxRefusal> {
  return inQueue(() => openNow(policy, opts));
}

async function openNow(policy: LocalSandboxPolicy, opts: { platform?: NodeJS.Platform; load?: () => Promise<Runtime> }): Promise<LocalSandbox | SandboxRefusal> {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    return { refused: "Windows has no local sandbox for the agent's commands.", hint: "Run foldrun inside WSL2, or send the task to the cloud." };
  }
  if (platform !== "darwin" && platform !== "linux") return { refused: `no local sandbox on ${platform}.`, hint: "Send the task to the cloud." };
  // The launcher and the probe's network check are bash's.
  if (!opts.load && LAUNCHER !== "/bin/bash") return { refused: "the local sandbox needs bash at /bin/bash.", hint: "Install bash, or send the task to the cloud." };
  let isDir = false;
  try {
    isDir = fs.statSync(policy.cwd).isDirectory();
  } catch {
    /* refused below */
  }
  if (!isDir) return { refused: `${policy.cwd} is not a folder that exists.` };
  const cwd = realish(policy.cwd);
  const fold = foldCase(platform);
  // A project folder that holds the home folder (or is /) would make all of
  // it writable: there is no "outside" left to wall off.
  if (within(fold(realish(home())), fold(cwd))) {
    return { refused: `${cwd} holds your home folder — every file in it would be writable.`, hint: "Start foldrun code in a project folder." };
  }
  // One inside a credential folder: on Linux the runtime binds a writable
  // folder back into the folder it hides, so it would show through.
  const denies = [...DENY_READ, ...(policy.denyRead ?? [])].map((p) => fold(realish(expand(p))));
  if (denies.some((d) => within(fold(cwd), d))) return { refused: `${cwd} is inside a folder that holds credentials.`, hint: "Start foldrun code in a project folder." };
  const key = JSON.stringify({ ...policy, cwd });
  if (walls) {
    if (walls.key === key && !walls.down) {
      walls.users++;
      return handleOf(walls);
    }
    return { refused: "another local session's sandbox is open in this process with a different policy." };
  }

  // While the walls are up this process looks programs up only where no
  // command can write: the runtime starts its helpers by name from here.
  const ownWrites = RUNTIME_OWN_WRITES.map(expand);
  // The package cache a command may write (policy.cache), placed and checked
  // before anything else counts the folders a command may write (Codex,
  // FOL-272): never in or around the project, never reached through a link,
  // never around a credential folder — a cache a command can write that the
  // person's own npx or pip also reads would run what the sandbox planted.
  let ownCache: string | null = null;
  if (policy.cache) {
    const asked = path.resolve(expand(policy.cache));
    const why = cacheProblem(asked, cwd, denies, platform);
    if (why) return { refused: `the package cache ${asked} ${why}`, hint: "Set XDG_CACHE_HOME to a folder outside the project, or unset it." };
    ownCache = asked;
  }
  const early = [cwd, ...ownWrites, ...(ownCache ? [ownCache] : [])].map(realish);
  // The code that keeps the walls may not sit where a command can write,
  // nor hold such a folder — checked before any of the runtime is loaded.
  for (const { what, dir } of installTrees()) {
    const hit = early.find((root) => overlaps(fold(realish(dir)), fold(root)));
    if (hit) return { refused: `${what} (${dir}) overlaps ${hit}, a folder a command may write — it could rewrite it before the next run.`, hint: "Install foldrun globally (npm i -g foldrun) and run it from outside the project." };
  }
  const helpers = opts.load ? { dir: trustedPath(process.env.PATH, early, platform) } : helperFolder(trustedPath(process.env.PATH, early, platform), early, platform);
  if ("refused" in helpers) return { refused: helpers.refused, hint: "Install that program outside the project folder." };
  // And nothing in this process's environment that makes a helper the
  // runtime starts here load a library or run a file first: the runtime
  // starts them with this environment.
  const personEnv: NodeJS.ProcessEnv = { ...process.env };
  const loaderVars = Object.keys(process.env).filter((k) => LOADER_VARS.test(k));
  const saved: Record<string, string | undefined> = { PATH: process.env.PATH, CLAUDE_CODE_TMPDIR: process.env.CLAUDE_CODE_TMPDIR };
  for (const k of loaderVars) saved[k] = process.env[k];
  const restoreEnv = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (!opts.load) fs.rmSync(helpers.dir, { recursive: true, force: true });
  };
  process.env.PATH = helpers.dir;
  for (const k of loaderVars) delete process.env[k];
  let up: LocalSandbox | SandboxRefusal;
  try {
    up = await bringUp(policy, { ...opts, platform }, cwd, key, ownWrites, restoreEnv, personEnv, ownCache);
  } catch (err) {
    up = { refused: `the sandbox could not start: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (isRefusal(up)) restoreEnv();
  return up;
}

/** Why a package cache folder may not be made writable, or null: inside,
 *  around or equal to the project; reached through a symbolic link anywhere
 *  on its path (the person's own ~/.npm/_npx behind a link would become
 *  writable); or overlapping a credential folder. `denies` are folded,
 *  resolved credential folders. */
export function cacheProblem(cache: string, cwd: string, denies: string[], platform: NodeJS.Platform = process.platform): string | null {
  const fold = foldCase(platform);
  if (!path.isAbsolute(cache)) return "is not an absolute path.";
  const projects = [fold(path.resolve(cwd)), fold(realish(cwd))];
  const spellings = [fold(path.resolve(cache)), fold(realish(cache))];
  if (spellings.some((c) => projects.some((p) => overlaps(c, p)))) return "is inside or around the project folder, which a command can change.";
  // Every part of the path that exists must be a real folder, not a link.
  let at = path.parse(path.resolve(cache)).root;
  for (const part of path.resolve(cache).slice(at.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    let st: fs.Stats;
    try { st = fs.lstatSync(at); } catch { break; }
    // Only the system's own links (macOS /var, /tmp, owned by root) may be
    // on the way; any other could point the cache somewhere a command should
    // never write, wherever it sits (Codex). A folder on the way belongs to
    // root or to this person — another user could swap it for a link.
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (st.isSymbolicLink() && st.uid !== 0) return `goes through a symbolic link (${at}).`;
    if (!st.isSymbolicLink() && !st.isDirectory()) return `has a file where a folder should be (${at}).`;
    if (uid !== null && st.isDirectory() && st.uid !== 0 && st.uid !== uid) return `goes through a folder another user owns (${at}).`;
  }
  if (spellings.some((c) => denies.some((d) => within(c, d) || within(d, c)))) return "overlaps a folder that holds credentials.";
  return null;
}

async function bringUp(
  policy: LocalSandboxPolicy,
  opts: { platform: NodeJS.Platform; load?: () => Promise<Runtime> },
  cwd: string,
  key: string,
  ownWrites: string[],
  restoreEnv: () => void,
  personEnv: NodeJS.ProcessEnv,
  /** policy.cache, checked by cacheProblem in openNow; null: one in the temp folder. */
  ownCache: string | null,
): Promise<LocalSandbox | SandboxRefusal> {
  const personPath = personEnv.PATH;
  const platform = opts.platform;
  const fold = foldCase(platform);
  const denies = [...DENY_READ, ...(policy.denyRead ?? [])].map((p) => fold(realish(expand(p))));
  let rt: Runtime;
  try {
    rt = await (opts.load ?? (() => import("@anthropic-ai/sandbox-runtime")))();
  } catch (err) {
    return { refused: `the sandbox runtime did not load: ${err instanceof Error ? err.message : String(err)}`, hint: "Reinstall foldrun: npm i -g foldrun@latest" };
  }
  const M = rt.SandboxManager;
  if (!M.isSupportedPlatform()) return { refused: `the sandbox runtime does not support this ${platform} host.` };
  // This process's PATH is the helper folder now; the Linux helpers are
  // also pinned to their real files.
  const trusted = process.env.PATH!;
  const early = [cwd, ...ownWrites, ...(ownCache ? [ownCache] : [])];
  const pinned = platform === "linux" ? { rg: which("rg", trusted, early), bwrap: which("bwrap", trusted, early), socat: which("socat", trusted, early) } : { rg: null, bwrap: null, socat: null };
  const deps = M.checkDependencies(pinned.rg ? { command: pinned.rg } : undefined);
  const userns = () => platform === "linux" && appArmorRestrictsUserns();
  if (deps.errors.length) return { refused: `the sandbox cannot start: ${deps.errors.join("; ")}`, hint: userns() ? APPARMOR_HINT : installHint(platform) };
  // Without seccomp a Linux command can reach any Unix socket it can see —
  // a host service outside the site proxy. Not walls enough to call walls.
  const noSeccomp = deps.warnings.find((w) => /seccomp/i.test(w));
  if (platform === "linux" && noSeccomp) return { refused: `the sandbox cannot block Unix sockets here: ${noSeccomp}`, hint: "Use an x86-64 or arm64 machine, where foldrun ships the seccomp filter." };

  const tmp = realish(fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-sbx-")));
  const rmTmp = () => fs.rmSync(tmp, { recursive: true, force: true });
  if (denies.some((d) => within(fold(tmp), d))) {
    rmTmp();
    return { refused: `the temp folder ${tmp} is inside a folder that holds credentials.` };
  }
  // Checked against the credential folders before anything is made there.
  let cache = ownCache ?? path.join(tmp, "cache");
  try {
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    // Made now: checked once more as it stands, so a link put in its place
    // between the check and the mkdir is refused, not followed.
    const again = ownCache ? cacheProblem(cache, cwd, denies, platform) : null;
    if (again) {
      rmTmp();
      return { refused: `the package cache ${cache} ${again}` };
    }
    cache = realish(cache);
  } catch (err) {
    rmTmp();
    return { refused: `the package cache folder could not be made: ${err instanceof Error ? err.message : String(err)}` };
  }
  const writeRoots = [cwd, tmp, cache, ...ownWrites].map(realish);
  const hostPATH = process.env.PATH!;
  // What would let a command change the code that keeps the walls: none of
  // it may sit in a folder a command may write, nor hold one.
  for (const { what, dir } of installTrees()) {
    const hit = writeRoots.find((root) => overlaps(fold(realish(dir)), fold(root)));
    if (hit) {
      rmTmp();
      return { refused: `${what} (${dir}) overlaps ${hit}, a folder a command may write — it could rewrite it before the next run.`, hint: "Install foldrun globally (npm i -g foldrun) and run it from outside the project." };
    }
  }
  const credWrites = [...DENY_READ, ...(policy.denyRead ?? [])].flatMap((p) => [path.resolve(expand(p)), realish(expand(p))]);
  let protectedWrites: string[];
  try {
    // Asked with the person's own PATH (the helper folder is only this
    // process's): a bare program name in git's settings is found on it.
    // The person's whole environment as it was (their GIT_EXEC_PATH,
    // GIT_SSH_COMMAND, PAGER…): what their own next git command will have.
    protectedWrites = gitProtected(cwd, hostPATH, personEnv, writeRoots);
  } catch (err) {
    rmTmp();
    return { refused: `the git paths to protect could not be found: ${err instanceof Error ? err.message : String(err)}` };
  }

  // The probe's fixtures, made by the host outside every writable root: a
  // folder it can write and read (the outside-write check), and a separate
  // denied one with a "credential" in it (the read check).
  const fixtureRoot = within(fold(realish(home())), fold(tmp)) ? os.tmpdir() : home();
  const outsideDir = realish(fs.mkdtempSync(path.join(fixtureRoot, ".foldrun-probe-w-")));
  const deniedDir = realish(fs.mkdtempSync(path.join(fixtureRoot, ".foldrun-probe-r-")));
  const secret = path.join(deniedDir, "secret");
  fs.writeFileSync(secret, "probe");
  const cleanupProbe = () => {
    fs.rmSync(outsideDir, { recursive: true, force: true });
    fs.rmSync(deniedDir, { recursive: true, force: true });
  };
  if ([outsideDir, deniedDir].some((p) => [cwd, tmp].some((root) => within(fold(p), fold(root))))) {
    cleanupProbe();
    rmTmp();
    return { refused: "no folder outside the project to prove the walls against." };
  }

  try {
    await M.initialize({
      network: { allowedDomains: [...new Set(policy.sites)], deniedDomains: [] },
      filesystem: {
        denyRead: [...DENY_READ, ...(policy.denyRead ?? []), deniedDir].map(lit),
        allowWrite: [lit(cwd), lit(tmp), lit(cache)],
        // Credentials are not written either: a project that holds one of
        // those folders would otherwise grant writes into it.
        denyWrite: [...new Set([...protectedWrites, ...credWrites])].map(lit),
      },
      mandatoryDenySearchDepth: GIT_SEARCH_DEPTH,
      ...(pinned.rg ? { ripgrep: { command: pinned.rg } } : {}),
      ...(pinned.bwrap ? { bwrapPath: pinned.bwrap } : {}),
      ...(pinned.socat ? { socatPath: pinned.socat } : {}),
    });
  } catch (err) {
    cleanupProbe();
    rmTmp();
    return { refused: `the sandbox did not start: ${err instanceof Error ? err.message : String(err)}`, hint: userns() ? APPARMOR_HINT : undefined };
  }

  const backend: SandboxBackend = platform === "darwin" ? "seatbelt" : "bubblewrap";
  // A wrapped command's TMPDIR is the runtime's, read from this process when
  // it wraps (CLAUDE_CODE_TMPDIR, else /tmp/claude, which need not exist):
  // the session's own temp folder instead, restored when it comes down.
  process.env.CLAUDE_CODE_TMPDIR = tmp;
  const launcherEnv: Record<string, string> = { PATH: hostPATH, TMPDIR: tmp };
  for (const k of LAUNCHER_VARS) if (typeof process.env[k] === "string") launcherEnv[k] = process.env[k]!;
  const w: Walls = {
    key,
    gen: ++generation,
    users: 1,
    down: false,
    // Git's protections are found again for every launch: a repository a
    // command made, or a hooks path it set, since the walls went up counts
    // from the next command on. Not found = not launched.
    wrapRaw: async (command) => {
      // Found first, and a change told (its stale processes ended) before
      // anything is wrapped, one launch at a time. A discovery that fails
      // makes every token unverifiable; a listener that cannot end what it
      // holds refuses the launch.
      const revoke = async (token: string) => {
        const done = await Promise.allSettled([...w.listeners].map((l) => Promise.resolve().then(() => l(token))));
        if (done.some((d) => d.status === "rejected")) throw new Error("a process running under the earlier rules could not be ended");
      };
      const step = w.gate.then(async () => {
        let now: string[];
        try {
          now = gitProtected(cwd, hostPATH, personEnv, writeRoots);
        } catch (err) {
          w.last = "\0unverifiable";
          await revoke(w.last).catch(() => undefined);
          throw err;
        }
        w.rules = fileRules({ ...policy, cwd }, tmp, now, platform);
        const deny = [...new Set([...now, ...credWrites])].sort();
        const token = deny.join("\0");
        if (token !== w.last) {
          await revoke(token);
          w.last = token;
        }
        return { deny, token };
      });
      w.gate = step.catch(() => undefined);
      const { deny, token } = await step;
      const filesystem = { denyWrite: deny.map(lit) };
      const line = await M.wrapWithSandbox(command, LAUNCHER, { filesystem } as unknown as Parameters<typeof M.wrapWithSandbox>[2]);
      // A newer launch found other rules while this one was wrapped: this
      // line is not handed out.
      if (w.last !== token) throw new Error("the sandbox's rules changed while the command was being wrapped");
      return { line, token };
    },
    listeners: new Set(),
    last: "",
    gate: Promise.resolve(),
    fingerprint: () => [...new Set([...gitProtected(cwd, hostPATH, personEnv, writeRoots), ...credWrites])].sort().join("\0"),
    hostEnv: launcherEnv,
    personPath,
    rules: fileRules({ ...policy, cwd }, tmp, protectedWrites, platform),
    backend,
    tmp,
    // What the walls do, in a person's words: never what they are built on
    // (owner, 24 Nov 2026, FOL-271: "dont call about the tech we use under
    // the hood"). The backend stays in `backend` for the record and tests.
    describe:
      `changes stay here and in a package cache; keys and passwords can't be read; git hooks can't be changed; ` +
      `internet limited to ${policy.sites.length} approved site${policy.sites.length === 1 ? "" : "s"}`,
    writable: [cwd, tmp, ...(within(fold(cache), fold(tmp)) ? [] : [cache]), ...RUNTIME_OWN_WRITES],
    cache,
    teardown: async () => {
      if (w.down) return;
      w.down = true;
      try {
        await M.reset();
      } catch {
        /* already down */
      }
      restoreEnv();
      rmTmp();
      if (walls === w) walls = null;
    },
  };
  walls = w;

  // The probe: every wall is shown to hold, by an explicit answer from
  // inside and a check from outside, before anything runs. A write in the
  // project must land; a write to the outside folder must not; the
  // credential must not be read; a direct connection to a listener on this
  // machine (no proxy) must not get through; and the script must finish.
  let hits = 0;
  const server = net.createServer((sock) => {
    hits++;
    sock.destroy();
  });
  try {
    await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
    const port = (server.address() as net.AddressInfo).port;
    // The control: the same connection, unwalled, must get through, or the
    // check below would pass for a shell that cannot make it at all.
    const control = await runLine(`(exec 3<>/dev/tcp/127.0.0.1/${port}) && echo NET_OPEN`, cwd, w.hostEnv);
    for (let i = 0; i < 50 && hits === 0; i++) await new Promise((r) => setTimeout(r, 20));
    if (!control.out.includes("NET_OPEN") || hits === 0) throw new Error("the network check does not work in this shell");
    hits = 0;
    const mark = `.foldrun-sbx-${randomBytes(6).toString("hex")}`;
    const inside = path.join(cwd, mark);
    const outside = path.join(outsideDir, "written");
    const script = [
      "export PATH=/usr/bin:/bin:/usr/sbin:/sbin",
      `if touch ${q(inside)} 2>/dev/null; then echo IN_OK; else echo IN_DENIED; fi`,
      `if (echo x > ${q(outside)}) 2>/dev/null; then echo OUT_WROTE; else echo OUT_DENIED; fi`,
      `if cat ${q(secret)} >/dev/null 2>&1; then echo READ_OK; else echo READ_DENIED; fi`,
      `if (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null; then echo NET_OPEN; else echo NET_DENIED; fi`,
      "exit 0",
    ].join("; ");
    const { line } = await w.wrapRaw(script);
    const r = await runLine(line, cwd, w.hostEnv);
    const said = new Set(r.out.split("\n").map((l) => l.trim()).filter(Boolean));
    const wrote = fs.existsSync(inside);
    fs.rmSync(inside, { force: true });
    const leaked = fs.existsSync(outside);
    const fails: string[] = [];
    if (r.code !== 0) fails.push(`the check did not finish (${r.err.split("\n")[0] || `exit ${r.code}`})`);
    if (!said.has("IN_OK") || !wrote) fails.push("a command could not write the project");
    if (!said.has("OUT_DENIED") || leaked) fails.push("a write outside the project was not stopped");
    if (!said.has("READ_DENIED")) fails.push("a credential could be read");
    if (!said.has("NET_DENIED") || hits > 0) fails.push("a direct connection was not stopped");
    if (fails.length) {
      await w.teardown();
      return { refused: `the sandbox did not hold: ${fails.join("; ")}`, hint: userns() ? APPARMOR_HINT : undefined };
    }
  } catch (err) {
    await w.teardown();
    return { refused: `the sandbox could not be checked: ${err instanceof Error ? err.message : String(err)}`, hint: userns() ? APPARMOR_HINT : undefined };
  } finally {
    server.close();
    cleanupProbe();
  }
  return handleOf(w);
}
