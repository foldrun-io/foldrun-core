// Does a script tool's `run:` actually point at a program?
//
// The failure this exists for is the quietest one the format has. A script
// tool whose `run:` resolves to nothing does not raise an error at load: the
// definition parses, the tool is counted, the agent is told it has the
// capability — and then the call fails inside a turn as a tool error the
// model paraphrases into something plausible. `foldrun check` counted such a
// tool among the workspace's tools and printed "no problems", which is the
// one report that makes a typo invisible.
//
// The resolution here is the runtime's, not a second copy of it. That matters
// more than it looks: `run:` has six accepted spellings across three scopes,
// and a checker that reimplemented them would eventually disagree with the
// runner — passing a tool that cannot run, or failing one that can.

import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import matter from "gray-matter";
import { parseRuntime } from "./runtime.ts";

import { workspaceDir, workspaceTools, type ToolDef } from "./store.ts";
import { libraryDir, libraryTools } from "./library.ts";
import { resolveRunPath } from "./script-tools.ts";

export interface MissingProgram {
  /** The tool's name, as an agent would write it in `tools:`. */
  name: string;
  /** Which shelf it came off — the two resolve differently. */
  scope: "workspace" | "account";
  /** The `run:` as the definition spells it, after folder qualification. */
  run: string;
  /** The absolute path that was looked for, so the message can be acted on. */
  looked: string;
}

/**
 * Every script tool an agent here could call whose program is not on disk.
 *
 * Both shelves, because a grant reaches both and the runtime resolves
 * nearest-wins across them — a checker that only read the workspace would
 * call a working account tool broken.
 */
export function missingToolPrograms(tenant: string, workspace: string): MissingProgram[] {
  const dir = workspaceDir(tenant, workspace);
  // Tools are workspace- or account-scoped, so resolve as if from an agent
  // directory one level down — the same base the runtime and the tool tester
  // both use.
  const from = path.join(dir, "agents", "_probe");
  const libScripts = libraryDir(tenant, "scripts");

  const out: MissingProgram[] = [];
  const scan = (defs: Record<string, ToolDef>, scope: "workspace" | "account") => {
    for (const [name, def] of Object.entries(defs)) {
      if (def.kind !== "script") continue;
      const run = String((def.spec as { run?: unknown }).run ?? "");
      // A single-file tool carries its program in the body and has no path to
      // resolve. It is a shape we still accept, not a missing program.
      if (!run) continue;
      const looked = resolveRunPath(from, run, libScripts);
      if (!fs.existsSync(looked)) out.push({ name, scope, run, looked });
    }
  };

  scan(libraryTools(tenant), "account");
  scan(workspaceTools(tenant, workspace), "workspace");
  return out;
}

// ---------------------------------------------------------------- imports

/**
 * The Python standard library, top-level names: CPython's
 * sys.stdlib_module_names, plus what 3.13 removed (the image's python is
 * older than the list's). Never a declaration's business.
 */
const PY_STDLIB = new Set(
  `
  abc aifc annotationlib antigravity argparse array ast asynchat asyncio
  asyncore atexit audioop base64 bdb binascii bisect builtins bz2 cProfile
  calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys
  compileall compression concurrent configparser contextlib contextvars copy
  copyreg crypt csv ctypes curses dataclasses datetime dbm decimal difflib
  dis distutils doctest email encodings ensurepip enum errno faulthandler
  fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath
  getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http
  idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json
  keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math
  mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib
  nt ntpath nturl2path numbers opcode operator optparse os ossaudiodev
  pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix
  posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data
  pyexpat queue quopri random re readline reprlib resource rlcompleter runpy
  sched secrets select selectors shelve shlex shutil signal site smtpd
  smtplib sndhdr socket socketserver spwd sqlite3 sre_compile sre_constants
  sre_parse ssl stat statistics string stringprep struct subprocess sunau
  symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios
  textwrap this threading time timeit tkinter token tokenize tomllib trace
  traceback tracemalloc tty turtle turtledemo types typing unicodedata
  unittest urllib uu uuid venv warnings wave weakref webbrowser winreg
  winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo
`
    .trim()
    .split(/\s+/),
);

/** Distributions whose import name is not their own name, lower-cased. */
const PY_IMPORT_ALIASES: Record<string, string[]> = {
  beautifulsoup4: ["bs4"],
  pillow: ["PIL"],
  pyyaml: ["yaml"],
  "python-dateutil": ["dateutil"],
  "scikit-learn": ["sklearn"],
  "opencv-python": ["cv2"],
  "opencv-python-headless": ["cv2"],
  "python-docx": ["docx"],
  "python-pptx": ["pptx"],
  pymupdf: ["fitz", "pymupdf"],
  "google-api-python-client": ["googleapiclient"],
  "google-auth": ["google"],
  protobuf: ["google"],
  "psycopg2-binary": ["psycopg2"],
  "psycopg-binary": ["psycopg"],
  attrs: ["attr", "attrs"],
  "python-dotenv": ["dotenv"],
  pyjwt: ["jwt"],
  "typing-extensions": ["typing_extensions"],
};

/** The names `import` would use for a declared distribution. */
export function importNamesOf(requirement: string): string[] {
  const dist = requirement.split(/[[<>=!~@ ;]/)[0].trim().toLowerCase();
  return PY_IMPORT_ALIASES[dist] ?? [dist.replace(/[-.]/g, "_")];
}

/** Top-level modules a Python file imports; relative imports excluded. */
export function pythonImports(source: string): string[] {
  const out = new Set<string>();
  for (const line of source.split("\n")) {
    const from = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(line);
    if (from) out.add(from[1].split(".")[0]);
    const imp = /^\s*import\s+([A-Za-z_][\w.]*(?:\s+as\s+\w+)?(?:\s*,\s*[A-Za-z_][\w.]*(?:\s+as\s+\w+)?)*)/.exec(line);
    if (imp) for (const part of imp[1].split(",")) out.add(part.trim().split(/\s+/)[0].split(".")[0]);
  }
  return [...out];
}

/** Packages a JavaScript file imports or requires; relative and node: excluded. */
export function nodeImports(source: string): string[] {
  const out = new Set<string>();
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"'./][^"']*)["']/gm;
  for (const m of source.matchAll(re)) {
    const spec = m[1];
    if (spec.startsWith("node:")) continue;
    out.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
  }
  return [...out];
}

/** What the runner image provides without a declaration (run-container.ts). */
const IMAGE_NODE_MODULES = new Set(["playwright", "playwright-core", "axe-core", "@foldrun/core"]);

export interface UndeclaredImport {
  name: string;
  scope: "workspace" | "account";
  file: string;
  modules: string[];
  language: "python" | "node";
}

/**
 * Script tools whose program imports a package nothing declares. Advisory: a
 * warning, because the import may be satisfied some way this cannot see (a
 * vendored module in a subfolder, a package the agent's own `runtime:`
 * brings). What it catches is the common case — a tool that `import openpyxl`
 * with no `runtime:` anywhere, which runs fine on the laptop that has it and
 * fails on the platform on its first call.
 *
 * Declared means: the tool's own runtime (tool.md, requirements.txt,
 * package.json), the workspace's AGENTS.md runtime, or any agent's runtime
 * in the workspace — the union, so an agent-level declaration is trusted.
 */
export function undeclaredImports(tenant: string, workspace: string): UndeclaredImport[] {
  const dir = workspaceDir(tenant, workspace);
  const from = path.join(dir, "agents", "_probe");
  const libScripts = libraryDir(tenant, "scripts");
  const sharedPy = new Set<string>();
  const sharedNpm = new Set<string>();
  const addRuntime = (raw: unknown) => {
    const rt = parseRuntime(raw);
    if (!rt) return;
    for (const p of rt.packages) for (const n of importNamesOf(p)) sharedPy.add(n.toLowerCase());
    for (const n of rt.npm) sharedNpm.add(n.replace(/^(@[^/]+\/[^@]+|[^@]+).*$/, "$1"));
  };
  const readFront = (file: string) => {
    try {
      return matter(fs.readFileSync(file, "utf8")).data as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  addRuntime(readFront(path.join(dir, "AGENTS.md")).runtime);
  addRuntime(readFront(path.join(dir, "project.md")).runtime);
  const agentsRoot = path.join(dir, "agents");
  if (fs.existsSync(agentsRoot)) {
    for (const a of fs.readdirSync(agentsRoot)) addRuntime(readFront(path.join(agentsRoot, a, "agent.md")).runtime);
  }

  const out: UndeclaredImport[] = [];
  const scan = (defs: Record<string, ToolDef>, scope: "workspace" | "account") => {
    for (const [name, def] of Object.entries(defs)) {
      if (def.kind !== "script") continue;
      const run = String((def.spec as { run?: unknown }).run ?? "");
      if (!run) continue;
      const file = resolveRunPath(from, run, libScripts);
      if (!fs.existsSync(file)) continue;
      const own = parseRuntime((def.spec as { runtime?: unknown }).runtime);
      const ext = path.extname(file).toLowerCase();
      const source = fs.readFileSync(file, "utf8");
      const siblings = new Set(
        fs.readdirSync(path.dirname(file)).map((f) => f.replace(/\.(py|mjs|cjs|js|ts)$/, "").toLowerCase()),
      );
      if (ext === ".py" || (!ext && /^#!.*python/.test(source))) {
        const declared = new Set(sharedPy);
        for (const p of own?.packages ?? []) for (const n of importNamesOf(p)) declared.add(n.toLowerCase());
        const missing = pythonImports(source).filter(
          (m) => !PY_STDLIB.has(m) && !declared.has(m.toLowerCase()) && !siblings.has(m.toLowerCase()),
        );
        if (missing.length) out.push({ name, scope, file: run, modules: missing, language: "python" });
      } else if ([".js", ".mjs", ".cjs", ".ts"].includes(ext)) {
        const declared = new Set(sharedNpm);
        for (const n of own?.npm ?? []) declared.add(n.replace(/^(@[^/]+\/[^@]+|[^@]+).*$/, "$1"));
        const missing = nodeImports(source).filter(
          (m) => !builtinModules.includes(m) && !declared.has(m) && !IMAGE_NODE_MODULES.has(m),
        );
        if (missing.length) out.push({ name, scope, file: run, modules: missing, language: "node" });
      }
    }
  };
  scan(libraryTools(tenant), "account");
  scan(workspaceTools(tenant, workspace), "workspace");
  return out;
}
