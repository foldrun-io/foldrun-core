// Network: which sites a step's sandbox may reach.
//
//   network: trusted                 # the trusted list, plus what the step declares
//   network: open                    # any public site
//   network: none                    # only what the step declares
//   network: [api.example.com, "*.example.org"]          # add sites; the level stays
//   network: { level: trusted, allow: [api.example.com], defaults: false }
//
// Written on an agent, a workspace's AGENTS.md or the account's. The level
// and `defaults` are nearest-wins (agent, then workspace, then account);
// `allow` adds up across all three, so an account can name a site every
// agent may reach without each agent repeating it.
//
// Unset, an agent that reads the open web — `web` with fetch or browse — is
// `open`, because a search result can name any site and an allowlist would
// break it. Every other agent is `trusted`: package registries, source
// hosts and cloud SDKs, the list Anthropic's own cloud sandboxes start from
// (TRUSTED_SITES below), plus the hosts the step itself declares — its
// `apis:`, its remote MCP servers, its web providers, the sites its secrets
// are bound to. That is the default the cloud sandboxes this platform is
// measured against use: least access, widened on purpose.
//
// The rule is enforced at the egress proxy, which every request from a
// sandbox goes through (HTTPS_PROXY in the pod), and, on the Kubernetes
// tier, by the pod's network policy: a `trusted` or `none` pod reaches the
// proxy and DNS and nothing else, so a program that ignores the proxy
// variables fails instead of going round. This file is the vocabulary; the
// proxy (foldrun-platform egress-proxy.ts) holds the rule per request.

/** How wide a step's network is. */
import { keySpan, dropEmptyBlock } from "./frontmatter-text.ts";

export type NetworkLevel = "open" | "trusted" | "none";

export const NETWORK_LEVELS: readonly NetworkLevel[] = ["open", "trusted", "none"];

/** One level's `network:` line, read. Absent fields inherit. */
export interface NetworkSetting {
  level?: NetworkLevel;
  /** Sites added at this level. */
  allow: string[];
  /** false drops the trusted list, leaving only `allow` and what the step declares. */
  defaults?: boolean;
}

/** What one step may reach, resolved. Plain JSON: it crosses into the egress
 *  grant and the run record. */
export interface NetworkPolicy {
  level: NetworkLevel;
  /** Every site allowed beyond what `open` would allow — the trusted list
   *  (unless dropped), the `allow` lists, and the hosts the step declares.
   *  Empty for `open`, which needs no list. */
  hosts: string[];
  /** Where the level came from, for the trace: "agent", "workspace",
   *  "account", or "default" with the reason. */
  from: string;
  /** Whether the trusted list is part of `hosts`. */
  defaults: boolean;
  /** The sites the files added (`allow`, every level), apart from the
   *  trusted list — what the trace and the dashboard show as "added". */
  added: string[];
  /** Hosts the step declares (apis, MCP servers, providers, bound secrets). */
  implied: string[];
}

/**
 * The trusted list: the domains Anthropic's Claude Code cloud environments
 * allow at their default "Trusted" level, as published on
 * code.claude.com/docs/en/cloud-environments#default-allowed-domains
 * (read 14 Oct 2026), plus the Debian mirrors the runner image installs
 * `runtime: system:` packages from. `*.` matches the subdomains and the
 * bare domain.
 */
export const TRUSTED_SITES: readonly string[] = [
  // Anthropic services
  "api.anthropic.com", "docs.claude.com", "platform.claude.com", "code.claude.com", "claude.ai", "claude.com",
  "support.claude.com", "anthropic.com", "www.anthropic.com",
  // Version control
  "github.com", "www.github.com", "api.github.com", "npm.pkg.github.com", "raw.githubusercontent.com",
  "pkg-npm.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
  "codeload.github.com", "avatars.githubusercontent.com", "camo.githubusercontent.com", "gist.github.com",
  "gitlab.com", "www.gitlab.com", "registry.gitlab.com", "bitbucket.org", "www.bitbucket.org", "api.bitbucket.org",
  // Container registries
  "registry-1.docker.io", "auth.docker.io", "index.docker.io", "hub.docker.com", "www.docker.com",
  "production.cloudflare.docker.com", "production.cloudfront.docker.com", "download.docker.com", "gcr.io",
  "*.gcr.io", "ghcr.io", "mcr.microsoft.com", "*.data.mcr.microsoft.com", "public.ecr.aws",
  // Cloud platforms
  "cloud.google.com", "accounts.google.com", "gcloud.google.com", "*.googleapis.com", "storage.googleapis.com",
  "compute.googleapis.com", "container.googleapis.com", "azure.com", "portal.azure.com", "microsoft.com",
  "www.microsoft.com", "*.microsoftonline.com", "packages.microsoft.com", "dotnet.microsoft.com", "dot.net",
  "visualstudio.com", "dev.azure.com", "*.amazonaws.com", "*.api.aws", "oracle.com", "www.oracle.com", "java.com",
  "www.java.com", "java.net", "www.java.net", "download.oracle.com", "yum.oracle.com", "*.r2.cloudflarestorage.com",
  // JavaScript and Node
  "registry.npmjs.org", "www.npmjs.com", "www.npmjs.org", "npmjs.com", "npmjs.org", "yarnpkg.com",
  "registry.yarnpkg.com", "jsr.io", "npm.jsr.io",
  // Python
  "pypi.org", "www.pypi.org", "files.pythonhosted.org", "pythonhosted.org", "test.pypi.org", "pypi.python.org",
  "pypa.io", "www.pypa.io",
  // Ruby
  "rubygems.org", "www.rubygems.org", "api.rubygems.org", "index.rubygems.org", "ruby-lang.org",
  "www.ruby-lang.org", "rubyforge.org", "www.rubyforge.org", "rubyonrails.org", "www.rubyonrails.org", "rvm.io",
  "get.rvm.io",
  // Rust
  "crates.io", "www.crates.io", "index.crates.io", "static.crates.io", "rustup.rs", "static.rust-lang.org",
  "www.rust-lang.org",
  // Go
  "proxy.golang.org", "sum.golang.org", "index.golang.org", "golang.org", "www.golang.org", "goproxy.io", "pkg.go.dev",
  // JVM
  "maven.org", "repo.maven.org", "central.maven.org", "repo1.maven.org", "repo.maven.apache.org",
  "maven.google.com", "jcenter.bintray.com", "gradle.org", "www.gradle.org", "services.gradle.org",
  "plugins.gradle.org", "plugins-artifacts.gradle.org", "kotlinlang.org", "www.kotlinlang.org", "spring.io",
  "repo.spring.io",
  // Other package managers
  "packagist.org", "www.packagist.org", "repo.packagist.org", "nuget.org", "www.nuget.org", "api.nuget.org",
  "pub.dev", "api.pub.dev", "hex.pm", "www.hex.pm", "cpan.org", "www.cpan.org", "metacpan.org", "www.metacpan.org",
  "api.metacpan.org", "cocoapods.org", "www.cocoapods.org", "cdn.cocoapods.org", "haskell.org", "www.haskell.org",
  "hackage.haskell.org", "swift.org", "www.swift.org",
  // Linux distributions — Anthropic's list, then Debian's (the runner image is Debian)
  "archive.ubuntu.com", "security.ubuntu.com", "ubuntu.com", "www.ubuntu.com", "*.ubuntu.com",
  "ppa.launchpad.net", "launchpad.net", "www.launchpad.net", "*.nixos.org",
  "deb.debian.org", "security.debian.org", "snapshot.debian.org",
  // Development tools and platforms
  "dl.k8s.io", "pkgs.k8s.io", "k8s.io", "www.k8s.io", "releases.hashicorp.com", "apt.releases.hashicorp.com",
  "rpm.releases.hashicorp.com", "archive.releases.hashicorp.com", "hashicorp.com", "www.hashicorp.com",
  "repo.anaconda.com", "conda.anaconda.org", "anaconda.org", "www.anaconda.com", "anaconda.com", "continuum.io",
  "apache.org", "www.apache.org", "archive.apache.org", "downloads.apache.org", "eclipse.org", "www.eclipse.org",
  "download.eclipse.org", "nodejs.org", "www.nodejs.org", "developer.apple.com", "developer.android.com",
  "pkg.stainless.com", "binaries.prisma.sh",
  // Cloud services and monitoring
  "http-intake.logs.datadoghq.com", "*.datadoghq.com", "*.datadoghq.eu", "api.honeycomb.io",
  // Content delivery and mirrors
  "sourceforge.net", "*.sourceforge.net", "packagecloud.io", "*.packagecloud.io", "fonts.googleapis.com",
  "fonts.gstatic.com",
  // Schema and configuration
  "json-schema.org", "www.json-schema.org", "json.schemastore.org", "www.schemastore.org",
  // Model Context Protocol
  "*.modelcontextprotocol.io",
];

/** A site as `network:` takes it: a domain or `*.domain` — no scheme, no
 *  path, no port. The same shape `web.browse.allowed_domains` takes. */
export const SITE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** A host as it arrives — `API.Example.com:443.` — as the lists hold it. */
export function normalHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.replace(/^\[|\](:\d+)?$/g, ""); // an IPv6 literal
  h = h.replace(/:\d+$/, "");
  return h.replace(/\.$/, "");
}

/** Does `site` (a domain or `*.domain`) cover `host`? `*.example.com`
 *  covers `a.example.com`, `a.b.example.com` and `example.com` itself. */
export function siteCovers(site: string, host: string): boolean {
  const h = normalHost(host);
  const s = site.toLowerCase();
  if (s.startsWith("*.")) {
    const base = s.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === s;
}

/** May a step under `policy` reach `host`? `open` reaches any public host —
 *  the caller still refuses private addresses, which no level opens. */
export function networkAllows(policy: Pick<NetworkPolicy, "level" | "hosts">, host: string): boolean {
  if (policy.level === "open") return true;
  return policy.hosts.some((s) => siteCovers(s, host));
}

/** A list of sites from YAML's list or one comma-separated line. */
function siteList(v: unknown): string[] | null {
  if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.map((x) => x.trim()).filter(Boolean);
  return null;
}

/**
 * One `network:` value, read. Never throws: what cannot be read is a
 * problem `check` and deploy report, and the run treats that level as
 * saying nothing — the next level up, or the default, decides.
 */
export function readNetwork(raw: unknown, where = "network"): { setting: NetworkSetting | null; problems: string[] } {
  if (raw === undefined || raw === null) return { setting: null, problems: [] };
  const problems: string[] = [];
  const sites = (v: unknown, key: string): string[] => {
    const list = siteList(v);
    if (!list) {
      problems.push(`${key} is a list of sites, like [api.example.com, "*.example.org"].`);
      return [];
    }
    const out: string[] = [];
    for (const s of list.map((x) => x.toLowerCase())) {
      if (/^https?:\/\//.test(s) || s.includes("/")) problems.push(`${key}: ${s} — a site is a domain, no scheme or path: ${s.replace(/^https?:\/\//, "").split("/")[0]}`);
      else if (/:\d+$/.test(s)) problems.push(`${key}: ${s} — a site has no port; every port of the host is covered`);
      else if (!SITE.test(s)) problems.push(`${key}: ${s} is not a domain or *.domain`);
      else out.push(s);
    }
    return out;
  };
  const level = (v: unknown, key: string): NetworkLevel | undefined => {
    if (typeof v === "string" && (NETWORK_LEVELS as readonly string[]).includes(v.trim().toLowerCase())) {
      return v.trim().toLowerCase() as NetworkLevel;
    }
    problems.push(`${key} is ${NETWORK_LEVELS.join(", ")} — not ${JSON.stringify(v)}.`);
    return undefined;
  };
  if (typeof raw === "string" && (NETWORK_LEVELS as readonly string[]).includes(raw.trim().toLowerCase())) {
    return { setting: { level: raw.trim().toLowerCase() as NetworkLevel, allow: [] }, problems };
  }
  if (typeof raw === "string" || Array.isArray(raw)) {
    // A bare word that is not a level reads as a site only when it looks
    // like one — `network: closed` is a typo, not a domain called "closed".
    if (typeof raw === "string" && !raw.includes(".") && !raw.includes(",")) {
      return { setting: null, problems: [`${where} is ${NETWORK_LEVELS.join(", ")}, a list of sites, or {level, allow, defaults} — not "${raw}".`] };
    }
    const allow = sites(raw, where);
    return { setting: problems.length && !allow.length ? null : { allow }, problems };
  }
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!["level", "allow", "defaults"].includes(k)) problems.push(`${where}.${k} is not a key — level, allow, defaults.`);
    }
    const setting: NetworkSetting = { allow: [] };
    if (o.level !== undefined) setting.level = level(o.level, `${where}.level`);
    if (o.allow !== undefined) setting.allow = sites(o.allow, `${where}.allow`);
    if (o.defaults !== undefined) {
      if (o.defaults === true || o.defaults === false) setting.defaults = o.defaults;
      else problems.push(`${where}.defaults is true or false — false drops the trusted list.`);
    }
    return { setting, problems };
  }
  return { setting: null, problems: [`${where} is ${NETWORK_LEVELS.join(", ")}, a list of sites, or {level, allow, defaults}.`] };
}

/** `check`'s and deploy's view: the problems only. */
export function networkProblems(raw: unknown): string[] {
  return readNetwork(raw).problems;
}

/**
 * The step's network, from its three levels and what it declares.
 *
 * `readsWeb` — the step may fetch or browse the open web (the `web` tool
 * with fetch or browse). It decides the default level only; a `network:`
 * written anywhere beats it.
 */
export function resolveNetwork(args: {
  account?: unknown;
  workspace?: unknown;
  agent?: unknown;
  readsWeb: boolean;
  implied?: Iterable<string>;
}): NetworkPolicy {
  const levels: [string, NetworkSetting | null][] = [
    ["agent", readNetwork(args.agent).setting],
    ["workspace", readNetwork(args.workspace).setting],
    ["account", readNetwork(args.account).setting],
  ];
  const levelHit = levels.find(([, s]) => s?.level);
  const level: NetworkLevel = levelHit ? levelHit[1]!.level! : args.readsWeb ? "open" : "trusted";
  const from = levelHit ? levelHit[0] : args.readsWeb ? "default — the agent reads the web" : "default";
  const defaultsHit = levels.find(([, s]) => s?.defaults !== undefined);
  const defaults = level === "trusted" && (defaultsHit ? defaultsHit[1]!.defaults! : true);
  const added = [...new Set(levels.flatMap(([, s]) => s?.allow ?? []))];
  const implied = [...new Set([...(args.implied ?? [])].map(normalHost).filter((h) => h && SITE.test(h)))];
  const hosts = level === "open" ? [] : [...new Set([...(defaults ? TRUSTED_SITES : []), ...added, ...implied])];
  return { level, hosts, from, defaults, added, implied };
}

/** One line for the run's trace. */
/** The sites a step reached, read from the egress lines on its trail
 *  (egress-proxy.ts formatDrain): `egress: CONNECT host:port …` and
 *  `egress: GET host/path → 200 …`. Lower-cased, port dropped, sorted. */
export function hostsInTrail(events: { type?: string; text?: string }[]): string[] {
  const hosts = new Set<string>();
  for (const e of events) {
    // A refused or unreachable call reached nothing: the proxy says so on
    // the same line (`… refused — …`, `… → unreachable: …`).
    if (typeof e.text === "string" && /^egress: \S+ \S+ (?:refused|unreachable|→ unreachable)\b/.test(e.text)) continue;
    const m = typeof e.text === "string" ? /^egress: (?:CONNECT ([^\s:]+)|[A-Z]+ ([^\s/:]+))/.exec(e.text) : null;
    const host = (m?.[1] ?? m?.[2])?.toLowerCase();
    if (host) hosts.add(host);
  }
  return [...hosts].sort();
}

/** `network_enforce: true` in the account's or the workspace's AGENTS.md:
 *  the steps here have a site off their list refused rather than only named.
 *  Either level switches it on; neither can switch off what the other, or the
 *  install (FOLDRUN_NETWORK_ENFORCE=1), switched on. */
export function networkEnforceWanted(account: unknown, workspace: unknown): boolean {
  return account === true || workspace === true;
}

export function networkLine(policy: NetworkPolicy, enforced: boolean | null): string {
  const how =
    enforced === null
      ? " — not enforced here (no sandbox network)"
      : enforced
        ? ""
        : " — report only: a site off the list is allowed and named in the trace (network_enforce: true in AGENTS.md refuses it)";
  if (policy.level === "open") return `network: open (${policy.from}) — any public site${how}`;
  const parts: string[] = [];
  if (policy.defaults) parts.push(`the trusted list (${TRUSTED_SITES.length} sites)`);
  if (policy.added.length) parts.push(`added: ${policy.added.join(", ")}`);
  if (policy.implied.length) parts.push(`declared by the step: ${policy.implied.join(", ")}`);
  const what = parts.length ? parts.join("; ") : "nothing but the platform's own services";
  return `network: ${policy.level} (${policy.from}) — ${what}${how}`;
}

/** What the proxy says when it refuses a site. */
export function refusalText(policy: Pick<NetworkPolicy, "level">, host: string): string {
  return `network: ${host} is not a site this step may reach (network: ${policy.level}). Add it to the agent's network: list — network: [${normalHost(host)}] — or set network: open.`;
}

/** The proxy variables a sandbox's programs read, for a forward-proxy URL
 *  (`http://foldrun:<token>@host:port`). Both spellings: curl reads only the
 *  lower-case http_proxy, much else only the upper-case. NO_PROXY keeps the
 *  cluster's own names — the egress address itself, the account's pods —
 *  off the proxy. NODE_USE_ENV_PROXY turns the variables on for Node's own
 *  fetch and http (Node 22.21 and later). */
export function proxyEnv(proxyUrl: string, extraNoProxy: string[] = []): Record<string, string> {
  let egressHost = "";
  try {
    egressHost = new URL(proxyUrl).hostname;
  } catch {
    // a malformed URL is still exported as given; the client says why it fails
  }
  const noProxy = [...new Set(["localhost", "127.0.0.1", "::1", ".svc", ".cluster.local", egressHost, ...extraNoProxy].filter(Boolean))].join(",");
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: "1",
    // Node 22 warns "EnvHttpProxyAgent is experimental" on the first request
    // of every process; a script tool's stderr then reads as an error to the
    // model. That one warning, and no other.
    NODE_OPTIONS: "--disable-warning=UNDICI-EHPA",
  };
}

/** The env var the egress CA travels in — its PEM, base64'd so it survives
 *  every env channel (docker's env file has no multi-line values). The
 *  pod's start writes it to a file and points every TLS client at a bundle
 *  that includes it. */
export const EGRESS_CA_ENV = "FOLDRUN_EGRESS_CA";

/**
 * The shell the sandbox's start runs before anything else: when the step
 * carries the egress CA, write it, build a bundle of the system's CAs plus
 * it, and point every TLS client the image has at that bundle. The CA only
 * ever signs for hosts a secret is bound to — every other connection is a
 * tunnel the proxy cannot read — but those clients must trust it there.
 * Sourced after the env file, before system packages install (apt goes
 * through the proxy too). `dir` is a directory the start may write.
 */
export function egressCaSh(dir: string, systemBundle = "/etc/ssl/certs/ca-certificates.crt"): string {
  // Without the system's bundle to add to, a bundle of the egress CA alone
  // would make every other site untrusted — so only Node, which ADDS the
  // file to its own roots, is told; nothing else changes.
  return `if [ -n "\${${EGRESS_CA_ENV}:-}" ] && printf '%s' "\$${EGRESS_CA_ENV}" | base64 -d > ${dir}/egress-ca.pem 2>/dev/null; then
  if [ -s ${systemBundle} ] && cat ${systemBundle} ${dir}/egress-ca.pem > ${dir}/ca-bundle.pem; then
    export SSL_CERT_FILE=${dir}/ca-bundle.pem REQUESTS_CA_BUNDLE=${dir}/ca-bundle.pem CURL_CA_BUNDLE=${dir}/ca-bundle.pem PIP_CERT=${dir}/ca-bundle.pem GIT_SSL_CAINFO=${dir}/ca-bundle.pem
  fi
  export NODE_EXTRA_CA_CERTS=${dir}/egress-ca.pem
fi`;
}

/** A site as a YAML flow item: `*.x` would read as an alias, so it is quoted. */
const siteItem = (site: string) => (/^[a-z0-9]/.test(site) ? site : JSON.stringify(site));

/** `network:` as one line of YAML, the shortest of the three shapes that
 *  says it; null when there is nothing to say. */
export function networkYaml(setting: { level?: NetworkLevel; allow?: string[]; defaults?: boolean } | null): string | null {
  if (!setting) return null;
  const allow = [...new Set((setting.allow ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  const list = `[${allow.map(siteItem).join(", ")}]`;
  if (setting.defaults === false) {
    return `{ ${[setting.level ? `level: ${setting.level}` : "", allow.length ? `allow: ${list}` : "", "defaults: false"].filter(Boolean).join(", ")} }`;
  }
  if (setting.level && allow.length) return `{ level: ${setting.level}, allow: ${list} }`;
  if (setting.level) return setting.level;
  if (allow.length) return list;
  return null;
}

/**
 * The text of an agent.md (or AGENTS.md) with its `network:` replaced by
 * `setting` — or removed, for null — and every other byte as it was. The
 * old value's indented lines go with it, whatever shape it was written in.
 * Pure string work, so the dashboard runs it in the browser and the CLI on
 * a file, and both write exactly the same line.
 */
export function setNetworkSetting(raw: string, setting: { level?: NetworkLevel; allow?: string[]; defaults?: boolean } | null): string {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(eol);
  const value = networkYaml(setting);
  const line = value ? `network: ${value}` : null;
  if (lines[0]?.trim() !== "---") return line ? ["---", line, "---", ...lines].join(eol) : raw;
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close < 0) return raw;
  // Where network: is written — at the top or inside `guardrail:` — is
  // where it is set (frontmatter-text.ts); written nowhere, it goes last.
  const where = keySpan(lines.slice(1, close), "network");
  if (!where) {
    if (line) lines.splice(close, 0, line);
    return lines.join(eol);
  }
  const front = lines.slice(1, close);
  front.splice(where.at, where.end - where.at, ...(line ? [`${where.indent}${line}`] : []));
  const edited = !line && where.block !== null ? dropEmptyBlock(front, where.block) : front;
  return [lines[0], ...edited, ...lines.slice(close)].join(eol);
}
