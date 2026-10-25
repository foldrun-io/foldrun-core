// The scanner: rules about what a workspace's files could leak or let in.
//
// `foldrun check` already asks "will this run?" — a tool that exists, a step
// that names a real agent. This asks the other question a linter for agents
// has to: "is this safe to run?" A key pasted into a prompt, a knowledge file
// carrying hidden instructions, an agent that reads the open web, holds a
// secret and can post anywhere. Each is valid markdown; each is a finding.
//
// Shaped like eslint, gitleaks and trivy rather than like the rest of check:
//   · every finding names a stable rule id (`secret/hardcoded`), so CI can
//     track it, a person can ignore it with a reason, and SARIF can carry it;
//   · pure — files in, findings out. No fs, no network, no model. The CLI,
//     the deploy and the dashboard hand it the same {path, content} list and
//     get the same answer;
//   · a finding carries a fingerprint (rule, file, the line's text — not its
//     number), so a baseline survives an edit above it.
//
// Every rule here is advisory today (`warn` or `info`). A new rule that fails
// a check, or refuses a deploy, that passed yesterday is a behaviour change;
// `--fail-on warn` and `--security` are how a CI opts in now.
//
// Ignoring one: a comment on the line before (or the same line) —
//   <!-- foldrun-ignore secret/hardcoded: a revoked key kept as an example -->
//   # foldrun-ignore supply-chain/pipe-to-shell: the vendor's pinned installer
// or `foldrun-ignore-file <rule>: <reason>` anywhere in a file for all of it.
// The reason is required: an ignore without one ignores nothing and is itself
// reported, because "why is this allowed?" is the question a reviewer asks.

import crypto from "node:crypto";
import matter, { frontmatterErrorLine, frontmatterErrorText, parseLenient, configMatter } from "./matter.ts";
import { refNames } from "./refs.ts";
import { resolveNetwork } from "./network.ts";
import { frontmatterProblems, schemaKindOf } from "./frontmatter-schema.ts";

export type ScanLevel = "error" | "warn" | "info";
export type ScanCategory = "secret" | "security" | "content" | "supply-chain" | "config";

export interface ScanRule {
  id: string;
  category: ScanCategory;
  level: ScanLevel;
  /** One line, for a rule list. */
  title: string;
  /** Why it matters and what to do instead — the rule's docs, in short. */
  help: string;
  /** OWASP Top 10 for Agentic Applications (2026) ids it guards against. */
  owasp?: string[];
}

export interface ScanFile {
  /** Relative to the workspace root (`agents/x/agent.md`), or `library/…`. */
  path: string;
  content: string;
}

export interface ScanFinding {
  rule: string;
  level: ScanLevel;
  file: string;
  /** 1-indexed; absent for a finding about the whole file. */
  line?: number;
  message: string;
  /** Stable across edits elsewhere in the file: rule + file + line text. */
  fingerprint: string;
  /** This rule had more to say in this file than PER_FILE_RULE: this
   *  finding counts the rest, so what is not listed is not resolved. Its
   *  fingerprint is of everything it counts, so a change among them is new. */
  truncated?: true;
}

export interface ScanOptions {
  /** Tool names whose definition says `outward: true` — the CLI and the
   *  deploy resolve these across the library; the scanner also finds the
   *  workspace's own among the files it is given. */
  outwardTools?: Iterable<string>;
  /** Only these rule ids (or categories, `secret`, `security`, …). */
  only?: string[];
  /** The account AGENTS.md's `network:` — the level above the workspace's,
   *  which the files of one workspace do not carry. */
  accountNetwork?: unknown;
}

export const OWASP_URL = "https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026";

export const SCAN_RULES: readonly ScanRule[] = [
  {
    id: "secret/hardcoded",
    category: "secret",
    level: "warn",
    title: "A credential written into a file",
    help:
      "Anything in these files is deployed, versioned, readable by every agent and shown to the model. " +
      "Put it in the vault (`foldrun secrets set NAME`), write `${NAME}` where it is used, and bind it to its sites " +
      "(`foldrun secrets sites NAME api.example.com`) so it never enters a sandbox. Then rotate the key — it has already been copied.",
    owasp: ["ASI03"],
  },
  {
    id: "content/hidden-unicode",
    category: "content",
    level: "warn",
    title: "Invisible characters that can hide instructions",
    help:
      "Zero-width, bidirectional-override and Unicode tag characters render as nothing to a person and as text to a model — " +
      "the standard way to smuggle an instruction past a reviewer. Delete them; nothing legitimate in a prompt needs them.",
    owasp: ["ASI01", "ASI04", "ASI06"],
  },
  {
    id: "content/injection-phrase",
    category: "content",
    level: "warn",
    title: "Text that tries to override an agent's instructions",
    help:
      "Knowledge, memory, skills and tool descriptions are read as data by every agent that loads them. " +
      "A line like \"ignore previous instructions\" there is either an attack that arrived with the content or a copy-paste " +
      "that will confuse the model. Remove it, or quote it as an example inside a fenced block.",
    owasp: ["ASI01", "ASI06"],
  },
  {
    id: "content/encoded-blob",
    category: "content",
    level: "info",
    title: "A long encoded block in a prompt or document",
    help:
      "A few hundred characters of base64 in markdown is unreadable to a reviewer and readable to a model. " +
      "If it is data, move it to a file under knowledge/ or storage/ and link it; if it is an image, reference the file.",
    owasp: ["ASI01", "ASI04"],
  },
  {
    id: "security/lethal-trifecta",
    category: "security",
    level: "warn",
    title: "Reads untrusted content, holds private data and can send it out",
    help:
      "An agent with all three can be told — by any page it reads — to send what it holds anywhere it can reach. " +
      "Take one leg away: take it off the open network (`network: { level: trusted, allow: [the sites it needs] }` — a bare list only adds sites, " +
      "and an agent that reads the web stays open), split the reading and the sending into two agents (a step each, or a reader sub-agent with \`sandbox: own\`), " +
      "or guard its calls with a `hooks:` gate. An approval (`!`) on every outward step is the other answer.",
    owasp: ["ASI01", "ASI02", "ASI03"],
  },
  {
    id: "security/subagent-wider",
    category: "security",
    level: "info",
    title: "A sub-agent declares tools its parent does not have",
    help:
      "A sub-agent never gets more than its parent, so those tools are silently dropped inside the delegation — " +
      "and if that rule ever changed, they would be a privilege escalation. Grant them to the parent or remove them.",
    owasp: ["ASI03"],
  },
  {
    id: "security/subagent-own-sandbox",
    category: "security",
    level: "info",
    title: "A sub-agent works in its own sandbox, with tools its parent does not have",
    help:
      "`sandbox: own` on a sub-agent runs each job it is handed in a sandbox of its own, with its own tools, secrets and network — " +
      "not cut to the parent's. That is the point (a reader with the web and no secrets, under a writer with secrets and no web), " +
      "so this only says what it holds. Only its reply reaches the parent.",
    owasp: ["ASI03"],
  },
  {
    id: "supply-chain/pipe-to-shell",
    category: "supply-chain",
    level: "warn",
    title: "A download piped straight into a shell",
    help:
      "`curl … | sh` runs whatever the server returns today, unreviewed, in the sandbox that holds this workspace. " +
      "Declare the package under `runtime: system:` or `packages:`, or download, verify a checksum, then run.",
    owasp: ["ASI04", "ASI05"],
  },
  {
    id: "supply-chain/unpinned-mcp",
    category: "supply-chain",
    level: "warn",
    title: "An MCP server fetched at its latest version on every run",
    help:
      "`npx some-server` (or `@latest`) installs whatever was published last — a compromised release reaches every run the moment it ships. " +
      "Pin it: `npx some-server@1.4.2`.",
    owasp: ["ASI04"],
  },
  {
    id: "supply-chain/unpinned-package",
    category: "supply-chain",
    level: "info",
    title: "A runtime package with no version",
    help:
      "An unpinned package is a different program after its next release. Pin a range (`pandas>=2,<3`, `lodash@^4`) " +
      "so a run tomorrow uses what was tested today.",
    owasp: ["ASI04"],
  },
  {
    id: "supply-chain/known-vulnerability",
    category: "supply-chain",
    level: "warn",
    title: "A pinned runtime package with known vulnerabilities",
    help:
      "OSV.dev lists vulnerabilities for this exact version. Upgrade to a fixed one. An online check: `foldrun check --to <ws> --online`, " +
      "Checks → Check online, and the daily rescan.",
    owasp: ["ASI04"],
  },
  {
    id: "content/mcp-tool-text",
    category: "content",
    level: "warn",
    title: "An MCP server's tool text carries hidden or injected instructions",
    help:
      "What a remote MCP server says about its tools reaches the model as instructions. Hidden characters or an order in a tool " +
      "description is a server steering your agent. An online check, for servers reached by URL; a command server is never run to check it.",
    owasp: ["ASI01", "ASI04"],
  },
  {
    id: "config/unknown-field",
    category: "config",
    level: "warn",
    title: "A frontmatter field foldrun does not read here",
    help:
      "A misspelt field is not an error to YAML, so it is silently ignored: `tolls: [web]` leaves the agent with no tools. " +
      "A near-miss names the field it meant; a field read in another kind of file says where it belongs (warnings). " +
      "A field like nothing foldrun reads is a note, since another tool may own it.",
  },
  {
    id: "config/wrong-type",
    category: "config",
    level: "warn",
    title: "A frontmatter field holding the wrong kind of value",
    help: "A list where one name was meant, a map where a word was meant: the runtime does not read it. The message says what the field takes.",
  },
  {
    id: "config/invalid-value",
    category: "config",
    level: "warn",
    title: "A frontmatter value that does nothing",
    help:
      "`effort: extreme`, `size: giant`, `trigger: sometimes`, a cron the scheduler cannot read: each is ignored or falls back, " +
      "so the agent or flow quietly does something else. The message lists what the field takes.",
  },
  {
    id: "config/conflict",
    category: "config",
    level: "error",
    title: "A field set twice: at the top and inside its job block",
    help:
      "`limits:` at the top and `limits:` inside `guardrail:` cannot both be meant. The top one would be read and the other " +
      "quietly ignored, so the file is refused until one is removed.",
  },
  {
    id: "config/misplaced",
    category: "config",
    level: "error",
    title: "A field inside the wrong job block",
    help:
      "Each of the four blocks (governance, guardrail, observability, evaluation) holds its own fields. A setting written in " +
      "another block is not read — a guardrail under governance: guards nothing — so the file is refused until it is moved " +
      "to the block the message names, or to the top. A word foldrun does not read at all is only a note.",
  },
  {
    id: "config/invalid-frontmatter",
    category: "config",
    level: "warn",
    title: "Frontmatter that YAML cannot read",
    help:
      "A value with a colon followed by a space (`description: the format (Markdown, ::: directives)`) ends the YAML. " +
      "foldrun reads a skill like that by quoting the value, but the dashboard editor and the source API refuse to save it, " +
      "and other tools that read the file may not. Quote the value: `description: \"…\"`.",
  },
  {
    id: "config/missing-field",
    category: "config",
    level: "warn",
    title: "A required frontmatter field is missing",
    help: "A skill with no description is never loaded: the model chooses skills by their descriptions.",
  },
  {
    id: "check/ignore-needs-reason",
    category: "config",
    level: "warn",
    title: "A foldrun-ignore with no reason",
    help: "Write why after a colon: `foldrun-ignore secret/hardcoded: revoked key kept as an example`. Without one it ignores nothing.",
  },
];

/**
 * The rules `foldrun check` and the deploy have always had — "will this
 * run?" — given ids so a finding from them can be filtered, ignored,
 * baselined and carried in SARIF like the scanner's. Coarse on purpose, one
 * per kind of file; the message says exactly what is wrong. Their level is
 * each problem's own, so it is not fixed here.
 */
export const CHECK_RULES: readonly (Omit<ScanRule, "level"> & { level?: ScanLevel })[] = [
  { id: "agent/config", category: "config", title: "An agent's frontmatter or references are wrong", help: "A field foldrun cannot read, or a tool, skill, colleague or hook it names that does not exist. The message says which and what to write." },
  { id: "flow/config", category: "config", title: "A flow's steps or options are wrong", help: "A step naming no agent, an option value the parser cannot read, a verify: written as prose, or an arrangement that cannot have what its instruction asks for." },
  { id: "flow/outward-ungated", category: "security", title: "A step that acts outside the workspace with no check and no approval", help: "Give the step a verify: that reads what it did, or an approval (`!`), so a wrong post or send is caught before it repeats.", owasp: ["ASI02", "ASI09"] },
  { id: "tool/config", category: "config", title: "A tool's definition or program is wrong", help: "A run: program that does not exist, a package it imports that nothing declares, or a leftover type: field." },
  { id: "skill/config", category: "config", title: "A skill does not follow the skill format", help: "SKILL.md needs a name and a description the model can choose it by." },
  { id: "eval/config", category: "config", title: "An eval names nothing, or has no cases", help: "An eval names one agent or flow that exists and holds at least one case." },
  { id: "hook/config", category: "config", title: "A hook is not a valid hook, or a hooks: name resolves to nothing", help: "hooks/<name>/hook.md with on:, and run.mjs beside it; a run refuses a step whose hook is missing rather than run it unguarded." },
  { id: "knowledge/okf", category: "config", title: "A knowledge or memory document is not a conformant OKF bundle entry", help: "Each document needs a type:; dates are YYYY-MM-DD; stale documents are flagged so an agent does not treat them as current." },
  { id: "workspace/config", category: "config", title: "A workspace or account setting cannot be read", help: "AGENTS.md defaults — limits:, network:, foldrun_version: — that would leave every agent on the level above, and paths a deploy refuses." },
  { id: "library/config", category: "config", title: "A library entry is wrong", help: "The same rules as in a workspace, for the account's shared library." },
  { id: "paths/workspace-spelling", category: "config", title: "An older spelling of a workspace path", help: "`../../storage/x` still works; `workspace/storage/x` reads the same in every tool, script and check." },
];

/** The rule id of a check or deploy problem, from where it was found and
 *  the flow lint's tag when it has one. */
export function ruleForWhere(where: string, kind?: string): string {
  if (kind === "outward") return "flow/outward-ungated";
  if (kind === "spelling") return "paths/workspace-spelling";
  if (/(?:^|\/)(?:knowledge|memory)\//.test(where)) return "knowledge/okf";
  const lib = where.startsWith("library/");
  const top = where.replace(/^library\//, "").split(/[/: ]/)[0] ?? "";
  const byTop: Record<string, string> = {
    agents: "agent/config", flows: "flow/config", tools: "tool/config", skills: "skill/config",
    ".agents": "skill/config", ".claude": "agent/config", evals: "eval/config", hooks: "hook/config",
  };
  if (byTop[top]) return byTop[top]!;
  return lib || top === "library" ? "library/config" : "workspace/config";
}

const RULE_BY_ID = new Map<string, Omit<ScanRule, "level"> & { level?: ScanLevel }>([...SCAN_RULES, ...CHECK_RULES].map((r) => [r.id, r]));

/** The rule behind an id — the scanner's or check's own — or undefined. */
export function scanRule(id: string): (Omit<ScanRule, "level"> & { level?: ScanLevel }) | undefined {
  return RULE_BY_ID.get(id);
}

/** Where a rule's docs live — one page, an anchor per rule. */
export function ruleDocsUrl(id: string): string {
  return `https://docs.foldrun.io/checks#${id.replace(/\//g, "-")}`;
}

// ── fingerprints ───────────────────────────────────────────────────────────

/** rule + file + the text that was flagged, normalised. Not the line number:
 *  a baseline must survive a paragraph added above the finding. */
export function findingFingerprint(rule: string, file: string, text: string): string {
  return crypto.createHash("sha256").update(`${rule}\0${file}\0${text.trim().replace(/\s+/g, " ")}`).digest("hex").slice(0, 16);
}

// ── secrets ────────────────────────────────────────────────────────────────

/** Shapes of real credentials, from the issuers' documented formats — the
 *  same families gitleaks' default rules cover for the services agents use. */
const SECRET_SHAPES: [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "an Anthropic key"],
  [/\bsk-or-v1-[a-f0-9]{48,}\b/g, "an OpenRouter key"],
  [/\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, "an OpenAI-style API key"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{50,}\b/g, "a GitHub token"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "a GitLab token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "a Slack token"],
  [/https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g, "a Slack webhook URL"],
  [/https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{40,}/g, "a Discord webhook URL"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "a Google API key"],
  [/\bGOCSPX-[A-Za-z0-9_-]{24,}/g, "a Google OAuth client secret"],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g, "a Stripe key"],
  [/\bwhsec_[A-Za-z0-9+/=]{24,}/g, "a webhook signing secret"],
  [/\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{40,}\b/g, "a SendGrid key"],
  [/\bSK[0-9a-f]{32}\b/g, "a Twilio API key"],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g, "a Telegram bot token"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "an npm token"],
  [/\bhf_[A-Za-z0-9]{34,}\b/g, "a Hugging Face token"],
  [/\blin_api_[A-Za-z0-9]{40}\b/g, "a Linear key"],
  [/\bdop_v1_[a-f0-9]{64}\b/g, "a DigitalOcean token"],
  [/\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g, "a Shopify token"],
  [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/g, "a Resend key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "a JSON web token"],
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g, "a private key"],
];

/** `api_key: abc…`, `"token": "…"`, `PASSWORD=…` — a named credential with a
 *  literal value. The value test is strict on purpose: a generic rule that
 *  cries wolf on `token: ${API_TOKEN}` gets the whole scanner ignored. */
const ASSIGNED =
  /\b([A-Za-z0-9_]*(?:api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|bearer[_-]?token|token|passwd|password|private[_-]?key))["']?\s*[:=]\s*["']?([A-Za-z0-9_\-+/=.]{16,})["']?/gi;

const BEARER = /\bBearer\s+([A-Za-z0-9_\-.=+/]{20,})/g;
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:([^\s@/'"]{6,})@[^\s'"]+/gi;

const PLACEHOLDER = /example|sample|dummy|placeholder|changeme|your[_-]|xxxx|\*\*\*\*|<[^>]*>|\.\.\.|redacted|insert|replace|todo|fake|test[_-]?key|not[_-]?a[_-]?real/i;

/** Shannon entropy, bits per character. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A name in code — `x25519_private_key`, `self.session_token`,
 *  `MLKEM768X25519PrivateKey` — rather than random characters. Split on
 *  separators and case and digit boundaries: an identifier comes apart into
 *  words, a key into fragments. */
function identifierLike(value: string): boolean {
  if (!/^[A-Za-z_$][\w$.-]*$/.test(value)) return false;
  const parts = value.split(/[_.$-]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/).filter(Boolean);
  if (parts.length < 2) return false;
  const words = parts.filter((p) => /^[A-Za-z]+$/.test(p));
  if (!parts.every((p) => /^[A-Za-z]+$/.test(p) || /^\d{1,5}$/.test(p))) return false;
  const long = words.filter((w) => w.length >= 3 && /[aeiouy]/i.test(w));
  return long.length >= 2 && long.length >= words.length / 2;
}

/** Looks like a real credential rather than a name, a reference or a sample. */
function credentialLike(value: string): boolean {
  if (/^\$\{?[A-Za-z_]/.test(value)) return false; // ${NAME}, $NAME
  if (PLACEHOLDER.test(value)) return false;
  if (/^(?:true|false|null|none|required|optional)$/i.test(value)) return false;
  // An identifier, a dotted path or a file name is a reference to a value.
  if (/^[a-z_][a-z0-9_]*$/i.test(value) && !/\d/.test(value)) return false;
  if (identifierLike(value)) return false;
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  if (/^(.)\1+$/.test(value)) return false;
  return entropy(value) >= 3.5;
}

/** What a finding may show of a secret: enough to find it, not to use it. */
export function redactSecret(secret: string): string {
  return secret.length <= 8 ? "****" : `${secret.slice(0, 4)}…${secret.slice(-2)}`;
}

/** Every credential in a piece of text, as [value, what]. One reading for
 *  the secret rule and for any other rule that quotes the line. */
function credentialsIn(line: string): [string, string][] {
  const out: [string, string][] = [];
  const seen = new Set<string>();
  const add = (v: string, what: string) => {
    if (!seen.has(v)) {
      seen.add(v);
      out.push([v, what]);
    }
  };
  for (const [re, what] of SECRET_SHAPES) {
    if (what === "a private key") continue; // a header names a key; it is not one
    for (const m of line.matchAll(re)) {
      if (!PLACEHOLDER.test(m[0]) && entropy(m[0]) >= 3) add(m[0], what);
    }
  }
  for (const m of line.matchAll(ASSIGNED)) if (credentialLike(m[2]!)) add(m[2]!, `\`${m[1]}\` with a literal value`);
  for (const m of line.matchAll(BEARER)) if (credentialLike(m[1]!)) add(m[1]!, "a bearer token");
  return out;
}

/** The text with every credential in it redacted — for a finding that
 *  quotes source, so no message ever carries a key whole. */
export function redactText(text: string): string {
  let out = text;
  for (const [v] of credentialsIn(text).sort((a, b) => b[0].length - a[0].length)) out = out.split(v).join(redactSecret(v));
  return out;
}

function scanSecrets(file: ScanFile, lines: string[], push: Push) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 4000) continue; // a minified bundle; not where keys are pasted
    const said = new Set<string>();
    const hit = (value: string, what: string) => {
      if (said.has(value)) return;
      said.add(value);
      push("secret/hardcoded", file.path, i + 1, line, `${what} (${redactSecret(value)}) is written into the file — move it to the vault and write \`\${NAME}\``);
    };
    for (const [re, what] of SECRET_SHAPES) {
      for (const m of line.matchAll(re)) {
        const v = m[0];
        if (what === "a private key") {
          // The header alone is a constant in every crypto library; a key
          // has its base64 body after it, on the next line or after a \n.
          const after = line.slice((m.index ?? 0) + v.length) + "\n" + (lines[i + 1] ?? "");
          if (!/^(?:\\n|\s)*[A-Za-z0-9+/=]{40,}/.test(after.replace(/^["',]*/, ""))) continue;
        } else if (PLACEHOLDER.test(v) || entropy(v) < 3) continue;
        hit(v, what);
      }
    }
    if (said.size) continue;
    for (const m of line.matchAll(ASSIGNED)) {
      if (credentialLike(m[2]!)) hit(m[2]!, `\`${m[1]}\` with a literal value`);
    }
    for (const m of line.matchAll(BEARER)) {
      if (credentialLike(m[1]!)) hit(m[1]!, "a bearer token");
    }
    for (const m of line.matchAll(URL_PASSWORD)) {
      const pw = m[1]!;
      // `user:password@host` in a docstring, `{password}` in a template.
      if (/[{}%<>$()\\]/.test(pw) || PLACEHOLDER.test(pw) || /^(?:pass(?:word|wd)?|secret|pwd|token|\*+)$/i.test(pw)) continue;
      if (/^[a-z]+$/i.test(pw) && pw.length < 20) continue;
      hit(pw, "a password in a URL");
    }
  }
}

// ── content: what a model reads that a person cannot see ───────────────────

/** Zero-width, bidi controls and the Unicode tag block (U+E0000–E007F, the
 *  "ASCII smuggling" range). A BOM at the very start of a file is allowed. */
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|\uDB40[\uDC00-\uDC7F]/g;

const HIDDEN_NAMES: [RegExp, string][] = [
  [/\uDB40[\uDC00-\uDC7F]/, "Unicode tag characters"],
  [/[‪-‮⁦-⁩]/, "bidirectional overrides"],
  [/[​-‏⁠-⁤﻿]/, "zero-width characters"],
];

const INJECTION: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)*(?:previous|prior|above|earlier|preceding|system|original)\s+(?:instructions|prompts?|rules|directions|context)\b/i,
  /\byou\s+are\s+no\s+longer\b/i,
  /\bnew\s+(?:system\s+)?instructions\s*:/i,
  /<\/?\s*(?:system|im_start|im_end)\s*>|\[\/?(?:SYSTEM|INST)\]|<\|im_start\|>/i,
  /\bdo\s+not\s+(?:tell|inform|mention\s+(?:this\s+)?to)\s+the\s+user\b/i,
  /\b(?:send|post|upload|exfiltrate)\s+(?:all\s+|the\s+|every\s+)?(?:secrets?|credentials|api\s+keys?|tokens?|env(?:ironment)?\s+variables)\s+to\b/i,
];

const BLOB = /[A-Za-z0-9+/]{300,}={0,2}/g;

function scanContent(file: ScanFile, lines: string[], push: Push, untrusted = false) {
  // Untrusted text (a remote server's) is read as data, every line: it
  // cannot fence an order off as an "example" either.
  const md = untrusted || /\.md$/i.test(file.path);
  const data = untrusted || isDataDoc(file.path);
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = i === 0 ? lines[i]!.replace(/^﻿/, "") : lines[i]!;
    if (!untrusted && /^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    HIDDEN.lastIndex = 0;
    if (HIDDEN.test(line)) {
      const kind = HIDDEN_NAMES.find(([re]) => re.test(line))?.[1] ?? "invisible characters";
      const n = line.match(HIDDEN)?.length ?? 0;
      const tagged = /\uDB40[\uDC00-\uDC7F]/.test(line) ? ` that read as: "${decodeTags(line).slice(0, 80)}"` : "";
      push("content/hidden-unicode", file.path, i + 1, line, `${n} ${kind}${redactText(tagged)} — invisible to a reviewer, read by the model`);
    }
    // An instruction quoted inside a fence is an example of one, not one.
    if (data && !fenced) {
      const m = INJECTION.find((re) => re.test(line));
      if (m) push("content/injection-phrase", file.path, i + 1, line, `"${redactText(line.trim()).slice(0, 90)}" — agents read this file as data, and this line reads as an order`);
    }
    if (md) {
      for (const b of line.matchAll(BLOB)) {
        const before = line.slice(Math.max(0, (b.index ?? 0) - 40), b.index);
        if (/data:[\w/+.-]+;base64,$/.test(before)) continue; // an inline image says what it is
        push("content/encoded-blob", file.path, i + 1, line, `${b[0].length} characters of base64 — a reviewer cannot read what the model will`);
        break;
      }
    }
  }
}

/**
 * Text from outside the workspace — what a remote MCP server says about its
 * tools — through the content rules with nothing the text itself can turn
 * off: no foldrun-ignore, no binary or vendored-path skip, no fences
 * (FOL-58, Codex review: each of those let a server silence its own finding).
 */
export function untrustedTextFindings(text: string): { rule: string; line: number; message: string }[] {
  const out: { rule: string; line: number; message: string }[] = [];
  scanContent({ path: "untrusted", content: text }, text.split(/\r?\n/), (rule, _file, line, _text, message) => out.push({ rule, line: line ?? 0, message }), true);
  return out;
}

/** The text hidden in tag characters: each is U+E0000 + an ASCII code. */
function decodeTags(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCharCode(cp - 0xe0000);
  }
  return out;
}

/** Files an agent reads as material rather than as its own instructions. */
function isDataDoc(p: string): boolean {
  const rel = p.replace(/^library\//, "");
  return /^(?:knowledge|memory|skills)\//.test(rel) || /^agents\/[^/]+\/(?:knowledge|memory|skills)\//.test(rel) || /^tools\/.+\.md$/.test(rel);
}

// ── supply chain ───────────────────────────────────────────────────────────

const PIPE_TO_SHELL = /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/;

function scanSupplyChain(file: ScanFile, lines: string[], push: Push) {
  for (let i = 0; i < lines.length; i++) {
    if (PIPE_TO_SHELL.test(lines[i]!)) {
      push("supply-chain/pipe-to-shell", file.path, i + 1, lines[i]!, "downloads and runs a script unreviewed");
    }
  }
}

/** `npx pkg`, `npx -y pkg@latest`, `uvx pkg` — the package argument, if it
 *  carries no exact version. */
function unpinnedRunner(command: unknown, args: unknown): string | null {
  const parts = [command, ...(Array.isArray(args) ? args : [])].filter((x): x is string => typeof x === "string");
  const words = parts.flatMap((p) => p.split(/\s+/)).filter(Boolean);
  const runner = words.findIndex((w) => /^(?:npx|bunx|pnpx|uvx)$/.test(w) || w === "dlx");
  if (runner < 0) return null;
  const pkg = words.slice(runner + 1).find((w) => !w.startsWith("-"));
  if (!pkg) return null;
  if (/==/.test(pkg)) return null; // uvx pkg==1.2.0
  const at = pkg.lastIndexOf("@");
  const version = at > 0 ? pkg.slice(at + 1) : "";
  if (!version || version === "latest" || version === "next") return pkg;
  // uvx pins with ==; a bare name there is unpinned too.
  return null;
}

function unpinned(pkg: string): boolean {
  const s = pkg.trim();
  if (!s || s.startsWith("-") || /^(?:git\+|https?:|file:|\.|\/)/.test(s)) return false;
  // pip: ==, >=, ~=, <, !=; npm: name@range; a scoped npm name has a leading @.
  return !/[=<>~!]/.test(s) && !/.@./.test(s.replace(/^@/, "x"));
}

// ── frontmatter ────────────────────────────────────────────────────────────

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length]![b.length]!;
}

/** The known field a key was probably meant to be, or null. */
export function nearestField(key: string, known: readonly string[]): string | null {
  if (known.includes(key)) return null;
  const lower = key.toLowerCase().replace(/[-_]/g, "");
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of known) {
    const kl = k.toLowerCase().replace(/[-_]/g, "");
    if (kl === lower) return k; // disallowed_tools for disallowedTools
    const d = editDistance(lower, kl);
    if (d < bestD) [best, bestD] = [k, d];
  }
  const allowed = key.length <= 4 ? 1 : 2;
  return bestD <= allowed ? best : null;
}

function keyLine(lines: string[], key: string): number | undefined {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const top = new RegExp(`^${k}\\s*:`);
  const i = lines.findIndex((l) => top.test(l));
  if (i >= 0) return i + 1;
  // A key inside one of the four job blocks: indented, under its header.
  const inner = new RegExp(`^\\s+${k}\\s*:`);
  let inBlock = false;
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n]!;
    if (/^(governance|guardrail|observability|evaluation)\s*:\s*(#.*)?$/.test(l)) inBlock = true;
    else if (/^\S/.test(l)) inBlock = false;
    else if (inBlock && inner.test(l)) return n + 1;
  }
  return undefined;
}

/** Read-only: gray-matter caches by content, so two files with the same
 *  text share one object, and writing to it would leak between them. */
function frontOf(content: string, filePath?: string): Record<string, unknown> | null {
  if (!/^﻿?---\r?\n/.test(content)) return null;
  try {
    // An agent, a flow or AGENTS.md reads its job blocks as flat keys, as
    // the runtime does; every other document is read as written.
    const kind = filePath ? schemaKindOf(filePath) : null;
    return (kind === "agent" || kind === "flow" || kind === "agents-md" ? configMatter(content) : matter(content)).data as Record<string, unknown>;
  } catch {
    return null; // a frontmatter YAML cannot read is check's finding, not ours
  }
}

type Kind = "agent" | "flow" | "tool" | null;
function docKind(p: string): Kind {
  const rel = p.replace(/^library\//, "");
  if (/^agents\/[^/]+\/agent\.md$/.test(rel) || /^\.(?:claude|agents)\/agents\/[^/]+\.md$/.test(rel)) return "agent";
  if (/^flows\/[^/]+\.md$/.test(rel)) return "flow";
  if (/^tools\/[^/]+\/tool\.md$/.test(rel) || /^tools\/[^/]+\.md$/.test(rel)) return "tool";
  return null;
}

// ── agents: what one can reach, taken together ─────────────────────────────

const WRITE_METHODS = /\b(?:POST|PUT|PATCH|DELETE)\b/i;

interface AgentFacts {
  name: string;
  file: string;
  line?: number;
  data: Record<string, unknown>;
  lines: string[];
}

interface ToolFacts {
  data: Record<string, unknown>;
  lines: string[];
}

function scanAgents(agents: AgentFacts[], outward: Set<string>, toolDefs: Map<string, ToolFacts>, push: Push, networks: { account?: unknown; workspace?: unknown }) {
  const byName = new Map(agents.map((a) => [a.name, a]));
  for (const a of agents) {
    const d = a.data;
    const tools = refNames(d.tools);
    const denied = new Set(refNames(d.disallowedTools));
    const has = (t: string) => tools.includes(t) && !denied.has(t);

    // Untrusted: it reads the open web. (A webhook body is the other source;
    // that is a flow's trigger, and the flow-level rule is a later one.)
    const readsWeb = has("web") || tools.some((t) => /browse|fetch|scrape|crawl/i.test(t) && has(t));
    // Private: a secret it spends itself, an API or MCP server it holds.
    const secrets = Array.isArray(d.secrets) ? d.secrets.map(String) : [];
    const apis = Array.isArray(d.apis) ? d.apis : [];
    const mcp = d.mcpServers && typeof d.mcpServers === "object" ? Object.keys(d.mcpServers as object) : [];
    const privateLeg = [...secrets.map((s) => `secret ${s}`), ...apis.map((x: any) => `api ${x?.name ?? "?"}`), ...mcp.map((m) => `MCP ${m}`)];
    // Out: a sandbox open to every site, a tool marked outward, or an API it
    // may write to. The level is the runtime's own resolution — agent, then
    // workspace, then account, and open by default for an agent that reads
    // the web; a bare list of sites adds to a level, it does not set one.
    const openNet = resolveNetwork({ account: networks.account, workspace: networks.workspace, agent: d.network, readsWeb }).level === "open";
    const outwardTools = tools.filter((t) => outward.has(t) && !denied.has(t));
    const writeApis = apis.filter((x: any) => WRITE_METHODS.test(JSON.stringify(x?.methods ?? x?.method ?? "")));
    const outLeg = [...(openNet ? ["an open network"] : []), ...outwardTools.map((t) => `outward tool ${t}`), ...writeApis.map((x: any) => `writes to api ${x?.name ?? "?"}`)];
    const gated = refNames(d.hooks).length > 0 || d.permissionMode === "plan";

    if (readsWeb && privateLeg.length && outLeg.length && !gated) {
      push(
        "security/lethal-trifecta", a.file, a.line, `trifecta ${a.name}`,
        `${a.name} reads the web, holds ${privateLeg.slice(0, 3).join(", ")}${privateLeg.length > 3 ? ", …" : ""} and can reach ${outLeg.slice(0, 2).join(" and ")} — ` +
          `a page it reads can tell it where to send what it holds. Take it off the open network (network: { level: trusted, allow: [...] }), split it, or add a hooks: gate`,
      );
    }

    // Sub-agents declaring tools the parent lacks.
    for (const s of refNames(d.subagents)) {
      const sub = byName.get(s);
      if (!sub || s === a.name) continue;
      const extra = refNames(sub.data.tools).filter((t) => !tools.includes(t));
      if (sub.data.sandbox === "own") {
        if (extra.length) {
          push("security/subagent-own-sandbox", a.file, keyLine(a.lines, "subagents"), `subagent ${s} own ${extra.join(",")}`,
            `subagents: [${s}] — ${s} runs in its own sandbox with ${extra.join(", ")}, which ${a.name} does not have; only its reply and the files it wrote come back`);
        }
        continue;
      }
      if (extra.length && tools.length) {
        push("security/subagent-wider", a.file, keyLine(a.lines, "subagents"), `subagent ${s} ${extra.join(",")}`,
          `subagents: [${s}] — ${s} declares ${extra.join(", ")}, which ${a.name} does not have; inside the delegation they are dropped`);
      }
    }

    // MCP servers launched by a package runner at no fixed version.
    for (const [name, spec] of Object.entries((d.mcpServers ?? {}) as Record<string, any>)) {
      const pkg = spec && typeof spec === "object" ? unpinnedRunner(spec.command, spec.args) : null;
      if (pkg) push("supply-chain/unpinned-mcp", a.file, keyLine(a.lines, "mcpServers"), `mcp ${name} ${pkg}`, `mcpServers.${name} runs \`${pkg}\` — whatever was published last; pin a version`);
    }
    runtimePackages(d.runtime, a.file, a.lines, push);
  }
  for (const [file, { data: def, lines }] of toolDefs) {
    const pkg = unpinnedRunner(def.command, def.args);
    if (pkg) push("supply-chain/unpinned-mcp", file, keyLine(lines, "command"), `mcp ${pkg}`, `command runs \`${pkg}\` — whatever was published last; pin a version`);
    runtimePackages(def.runtime, file, lines, push);
  }
}

function runtimePackages(runtime: unknown, file: string, lines: string[], push: Push) {
  if (!runtime || typeof runtime !== "object") return;
  const r = runtime as Record<string, unknown>;
  for (const key of ["packages", "npm"]) {
    const list = Array.isArray(r[key]) ? (r[key] as unknown[]).map(String) : [];
    const loose = list.filter(unpinned);
    if (loose.length) {
      push("supply-chain/unpinned-package", file, keyLine(lines, "runtime"), `runtime ${key} ${loose.join(",")}`,
        `runtime: ${key}: ${loose.slice(0, 4).join(", ")}${loose.length > 4 ? ", …" : ""} — no version; pin a range`);
    }
  }
}

// ── ignores ────────────────────────────────────────────────────────────────

const IGNORE = /foldrun-ignore(-file)?\s+([a-z0-9*][a-z0-9/*,\s-]*?)\s*(?::\s*(.*?))?\s*(?:-->|\*\/)?\s*$/i;

interface Ignores {
  file: Set<string>;
  /** 1-indexed line → rules ignored on it (from the line itself or the one before). */
  lines: Map<number, Set<string>>;
}

/** Memory is written by the agents themselves, so an ignore there could be
 *  written by whatever an agent read — an injection that silences its own
 *  finding. Only people's files may carry one. */
const AGENT_WRITTEN = /^(?:library\/)?(?:agents\/[^/]+\/)?memory\//;

function readIgnores(file: ScanFile, lines: string[], push: Push): Ignores {
  const out: Ignores = { file: new Set(), lines: new Map() };
  if (AGENT_WRITTEN.test(file.path)) return out;
  for (let i = 0; i < lines.length; i++) {
    const m = IGNORE.exec(lines[i]!);
    if (!m) continue;
    const rules = m[2]!.split(/[\s,]+/).filter(Boolean);
    if (!m[3]?.trim()) {
      push("check/ignore-needs-reason", file.path, i + 1, lines[i]!, `foldrun-ignore ${rules.join(", ")} has no reason, so it ignores nothing — add one after a colon`);
      continue;
    }
    if (m[1]) {
      for (const r of rules) out.file.add(r);
      continue;
    }
    for (const at of [i + 1, i + 2]) {
      const set = out.lines.get(at) ?? new Set<string>();
      for (const r of rules) set.add(r);
      out.lines.set(at, set);
    }
  }
  return out;
}

function ignored(ig: Ignores, rule: string, line?: number): boolean {
  const covers = (set: Set<string>) => set.has(rule) || set.has("*") || set.has(rule.split("/")[0]!) || set.has(`${rule.split("/")[0]}/*`);
  return covers(ig.file) || (line !== undefined && !!ig.lines.get(line) && covers(ig.lines.get(line)!));
}

// ── the scan ───────────────────────────────────────────────────────────────

type Push = (rule: string, file: string, line: number | undefined, text: string, message: string, level?: ScanLevel) => void;

/** Installed and built code: someone else's files, and a crypto library's
 *  constants are not this workspace's keys. */
const VENDORED = /(?:^|\/)(?:node_modules|\.venv|venv|site-packages|__pycache__|vendor|dist|build|\.next)\//;

/** What a run leaves in an agent's folder — the Claude CLI's `.cache/` logs,
 *  package caches — and copies back with it. Nobody wrote these, so they are
 *  not checked as prompts or code; they are still searched for credentials,
 *  since a key in a log here is a key in the workspace (seen live on
 *  17 Oct 2026: zero-width characters in a CLI MCP log, reported as hidden
 *  text). */
/** The definition files a deploy refuses outright when their frontmatter does
 *  not parse (deploy.ts deployIssues): the workspace's own, by these paths.
 *  Everything else the platform reads frontmatter from — skills, and the
 *  account library's agents, tools and hooks — is the scanner's to report. */
export const STRICT_FRONTMATTER_PATH = /^(AGENTS\.md|agents\/[^/]+\/agent\.md|flows\/[^/]+\.md|tools\/[^/]+\.md|tools\/[^/]+\/tool\.md|evals\/[^/]+\.md|hooks\/[^/]+\/hook\.md|\.claude\/agents\/[^/]+\.md)$/;

/** A skill file in either layout the runtime discovers: <name>/SKILL.md, or
 *  the flat <name>.md, under skills/ or .agents/skills/, in the library too. */
const SKILL_FILE = /(?:^|\/)skills\/(?:[^/]+\/SKILL\.md|[^/]+\.md)$/;

const RUNTIME_WRITTEN = /(?:^|\/)(?:\.cache|\.npm|\.local|\.pnpm-store|\.yarn|\.foldrun)\//;

/** Text files only — a PNG read as UTF-8 is noise to every rule here. */
function isText(f: ScanFile): boolean {
  return !VENDORED.test(f.path) && !f.content.slice(0, 8000).includes("\u0000") && !/\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp[34]|mov|wasm)$/i.test(f.path);
}

/** How many times one rule is listed for one file before the rest are counted. */
export const PER_FILE_RULE = 100;

/**
 * Every finding in these files, ignores applied. Findings are sorted by file
 * then line, and one rule says one thing once per line, and at most
 * PER_FILE_RULE times in one file.
 */
export function scanFiles(files: ScanFile[], options: ScanOptions = {}): ScanFinding[] {
  const want = options.only?.length ? new Set(options.only) : null;
  const enabled = (rule: string) => !want || want.has(rule) || want.has(scanRule(rule)?.category ?? "") || rule === "check/ignore-needs-reason";
  const findings: ScanFinding[] = [];
  const seen = new Set<string>();
  const ignoresByFile = new Map<string, Ignores>();
  // One rule in one file says it PER_FILE_RULE times, then counts the rest:
  // a million lines of hidden characters is one problem, not a million
  // findings held in memory (Codex review of the 20 Oct rescan outage).
  const perFileRule = new Map<string, number>();
  const more = new Map<string, { rule: string; file: string; level?: ScanFinding["level"]; n: number; hash: crypto.Hash }>();

  const push: Push = (rule, file, line, text, message, level) => {
    if (!enabled(rule)) return;
    const ig = ignoresByFile.get(file);
    if (ig && ignored(ig, rule, line)) return;
    const key = `${rule}\0${file}\0${line ?? ""}\0${message}`;
    if (seen.has(key)) return;
    const rf = `${rule}\0${file}`;
    const said = perFileRule.get(rf) ?? 0;
    if (said >= PER_FILE_RULE) {
      const m = more.get(rf) ?? { rule, file, level, n: 0, hash: crypto.createHash("sha256") };
      m.n++;
      m.hash.update(`${findingFingerprint(rule, file, text)}\0`);
      more.set(rf, m);
      return;
    }
    perFileRule.set(rf, said + 1);
    seen.add(key);
    findings.push({ rule, level: level ?? scanRule(rule)?.level ?? "warn", file, ...(line ? { line } : {}), message, fingerprint: findingFingerprint(rule, file, text) });
  };

  const outward = new Set(options.outwardTools ?? []);
  const agents: AgentFacts[] = [];
  const toolDefs = new Map<string, ToolFacts>();

  for (const f of files.filter(isText)) {
    const lines = f.content.split(/\r?\n/);
    ignoresByFile.set(f.path, readIgnores(f, lines, push));
    scanSecrets(f, lines, push);
    if (RUNTIME_WRITTEN.test(f.path)) continue;
    scanContent(f, lines, push);
    scanSupplyChain(f, lines, push);

    const schema = schemaKindOf(f.path);
    // Frontmatter YAML cannot read. Until 2026-10-21 nothing reported it for
    // a skill or a library file: frontOf below reads it as "no frontmatter"
    // and moves on, and the deploy's own refusal covers only the workspace's
    // definition files. A customer's skill with `description: … (Markdown,
    // frontmatter, ::: directives) …` deployed clean, ran (the runtime quotes
    // the value and retries), and was refused by the source API on its next
    // save.
    if ((schema || SKILL_FILE.test(f.path)) && !STRICT_FRONTMATTER_PATH.test(f.path) && /^\uFEFF?---\r?\n/.test(f.content)) {
      let err: unknown = null;
      try {
        matter(f.content);
      } catch (e) {
        err = e;
      }
      if (err) {
        const isSkill = schema === "skill" || SKILL_FILE.test(f.path);
        const read = parseLenient(f.content);
        const what = isSkill && !read.failed
          ? "foldrun reads this skill anyway by quoting the value, but the dashboard editor and the source API refuse to save it, and other skills clients may not load it"
          : isSkill
            ? "the runtime reads it as empty, so the skill has no name or description and is never loaded"
            : "the runtime cannot read this file";
        push("config/invalid-frontmatter", f.path, frontmatterErrorLine(err), `config/invalid-frontmatter ${frontmatterErrorText(err)}`, `${frontmatterErrorText(err)} ${what === "the runtime cannot read this file" ? "The runtime cannot read this file" : what.replace(/^foldrun/, "foldrun").replace(/^the/, "The")}.`);
      }
    }
    // A skill with no frontmatter at all is the clearest one that never
    // loads: read it as empty, so its required fields are reported.
    const data = schema || docKind(f.path) ? (frontOf(f.content, f.path) ?? (schema === "skill" && !/^\uFEFF?---\r?\n/.test(f.content) ? {} : null)) : null;
    if (!data) continue;
    if (schema) {
      for (const p of frontmatterProblems(schema, data, nearestField)) {
        // Fingerprint the key's own line, not the parsed value: a YAML alias
        // can make the value circular, and JSON of it would throw.
        const at = keyLine(lines, p.key);
        push(p.rule, f.path, at, `${p.rule} ${at ? lines[at - 1] : p.key}`, p.message, p.level);
      }
    }
    const kind = docKind(f.path);
    if (!kind) continue;
    if (kind === "agent") {
      const rel = f.path.replace(/^library\//, "");
      const name = /^agents\/([^/]+)\//.exec(rel)?.[1] ?? rel.replace(/^.*\/|\.md$/g, "");
      agents.push({ name, file: f.path, line: 1, data, lines });
    } else if (kind === "tool") {
      const name = typeof data.name === "string" ? data.name : f.path.replace(/^(?:library\/)?tools\//, "").replace(/(?:\/tool)?\.md$/, "");
      if (data.outward === true) outward.add(name);
      toolDefs.set(f.path, { data, lines });
    }
  }
  // project.md is the older name the runtime still reads (Codex review, FOL-58).
  const workspaceMd = files.find((f) => f.path === "AGENTS.md") ?? files.find((f) => f.path === "project.md");
  scanAgents(agents, outward, toolDefs, push, { account: options.accountNetwork, workspace: workspaceMd ? frontOf(workspaceMd.content, "AGENTS.md")?.network : undefined });
  for (const m of more.values()) {
    findings.push({ rule: m.rule, level: m.level ?? scanRule(m.rule)?.level ?? "warn", file: m.file, message: `and ${m.n} more like this in this file, not listed`, fingerprint: m.hash.digest("hex").slice(0, 16), truncated: true });
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule));
}

/**
 * Drop the findings a `foldrun-ignore` comment (with a reason) covers — for
 * findings that did not come from scanFiles, such as check's own rules, so
 * one comment syntax works for every rule. Ignores without a reason are
 * reported by scanFiles itself, once.
 */
export function filterIgnored<T extends { rule: string; file: string; line?: number }>(findings: T[], files: ScanFile[]): T[] {
  const byFile = new Map<string, Ignores>();
  const quiet: Push = () => {};
  for (const f of files) {
    if (f.content.includes("foldrun-ignore")) byFile.set(f.path, readIgnores(f, f.content.split(/\r?\n/), quiet));
  }
  return findings.filter((x) => {
    const ig = byFile.get(x.file);
    return !ig || !ignored(ig, x.rule, x.line);
  });
}

// ── baseline ───────────────────────────────────────────────────────────────

export interface ScanBaseline {
  version: 1;
  /** When it was written — for a person reading the file, not for matching. */
  created?: string;
  findings: { rule: string; file: string; fingerprint: string }[];
}

/** A baseline that accepts every finding here as known. */
export function makeBaseline(findings: Pick<ScanFinding, "rule" | "file" | "fingerprint">[], created = new Date().toISOString()): ScanBaseline {
  const uniq = new Map(findings.map((f) => [`${f.rule}\0${f.file}\0${f.fingerprint}`, { rule: f.rule, file: f.file, fingerprint: f.fingerprint }]));
  return { version: 1, created, findings: [...uniq.values()].sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule)) };
}

/** Findings not in the baseline, and how many it hid. A baseline that does
 *  not parse hides nothing — failing open would hide every new finding. */
export function applyBaseline<T extends Pick<ScanFinding, "rule" | "file" | "fingerprint">>(findings: T[], baseline: unknown): { kept: T[]; baselined: number } {
  const b = baseline as ScanBaseline | null;
  if (!b || b.version !== 1 || !Array.isArray(b.findings)) return { kept: findings, baselined: 0 };
  // An entry that is not {rule, file, fingerprint} hides nothing.
  const entries = (b.findings as unknown[]).filter(
    (f): f is ScanBaseline["findings"][number] =>
      !!f && typeof f === "object" && typeof (f as any).rule === "string" && typeof (f as any).file === "string" && typeof (f as any).fingerprint === "string",
  );
  const known = new Set(entries.map((f) => `${f.rule}\0${f.file}\0${f.fingerprint}`));
  const kept = findings.filter((f) => !known.has(`${f.rule}\0${f.file}\0${f.fingerprint}`));
  return { kept, baselined: findings.length - kept.length };
}

// ── SARIF 2.1.0, for GitHub code scanning and every CI that reads it ──────

export interface SarifFinding {
  rule: string;
  level: ScanLevel;
  file: string;
  line?: number;
  message: string;
  fingerprint: string;
}

export function toSarif(findings: SarifFinding[], opts: { version?: string; rules?: { id: string; title: string; help?: string }[]; root?: string } = {}) {
  const ids = [...new Set(findings.map((f) => f.rule))].sort();
  const extra = new Map((opts.rules ?? []).map((r) => [r.id, r]));
  const rules = ids.map((id) => {
    const r = scanRule(id) ?? extra.get(id);
    return {
      id,
      name: id.replace(/[/-](\w)/g, (_, c: string) => c.toUpperCase()),
      shortDescription: { text: r?.title ?? id },
      ...(r?.help ? { help: { text: r.help } } : {}),
      helpUri: ruleDocsUrl(id),
      properties: { tags: ["foldrun", id.split("/")[0], ...((scanRule(id)?.owasp ?? []).map((o) => `owasp-agentic/${o}`))] },
    };
  });
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "foldrun check", informationUri: "https://docs.foldrun.io/checks", ...(opts.version ? { version: opts.version } : {}), rules } },
        ...(opts.root ? { originalUriBaseIds: { SRCROOT: { uri: opts.root.endsWith("/") ? opts.root : `${opts.root}/` } } } : {}),
        results: findings.map((f) => ({
          ruleId: f.rule,
          ruleIndex: ids.indexOf(f.rule),
          level: f.level === "warn" ? "warning" : f.level === "info" ? "note" : "error",
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file, ...(opts.root ? { uriBaseId: "SRCROOT" } : {}) },
                ...(f.line ? { region: { startLine: f.line } } : {}),
              },
            },
          ],
          partialFingerprints: { "foldrun/v1": f.fingerprint },
        })),
      },
    ],
  };
}
