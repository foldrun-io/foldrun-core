// Editor completions.
//
// `[[` already suggested agents in flows. Everything else — methods, auth
// headers, tool names, secrets, cron — you had to remember or copy from
// another file. That's the same failure as an undocumented directory layout:
// the platform knows the answer and doesn't offer it.
//
// This is pure logic: given a path, the text, and the cursor, say what could
// go here. No React, no fetch — so the rules are testable and one component
// renders them.

export interface Vocabulary {
  agents: string[];
  flows: string[];
  skills: string[];
  tools: string[];
  secrets: string[];
  scripts: string[]; // already prefixed: workspace/scripts/x.py
  /** Everything [[ ]] can point at besides agents and flows: knowledge and
   *  memory docs, and paths in the file store. One reference syntax for the
   *  whole workspace — the Obsidian instinct, honoured. */
  docs?: { name: string; hint: string }[];
  /** OKF `type:` values already used here. The index groups by exact string,
   *  so offering what exists is what keeps a bundle consistent. */
  types: string[];
  /** The gateway's catalogue, when this workspace declares a provider —
   *  full ids with price and capability in the hint. Tiers stay first:
   *  they are the portable answer, the catalogue is the informed one. */
  models?: { id: string; hint: string }[];
}

export interface Completion {
  label: string;
  /** Text to insert in place of the query. Defaults to label. */
  insert?: string;
  hint?: string;
}

export interface CompletionContext {
  /** Character offset where the replacement starts. */
  from: number;
  query: string;
  items: Completion[];
  /** Shown above the list, e.g. "HTTP method". */
  title: string;
}

const MODELS: Completion[] = [
  { label: "fast", hint: "haiku — cheap, for checks and triage" },
  { label: "default", hint: "sonnet — the working default" },
  { label: "max", hint: "opus — the most capable" },
];

// Effort is the other knob, and the one people miss: it decides how long the
// model thinks, not which model thinks. `fast` + `max` is a real pairing —
// the cheap model, told to take its time — and no single tier can say it.
const EFFORTS: Completion[] = [
  { label: "low", hint: "minimal thinking, fastest" },
  { label: "medium", hint: "moderate" },
  { label: "high", hint: "deep reasoning — the default" },
  { label: "xhigh", hint: "deeper than high, where the model has it" },
  { label: "max", hint: "think hardest — correctness over cost" },
];

// `tools:` grants what the runtime provides. Group aliases first — they
// survive vendor renames — then the exact SDK names, accepted so a Claude Code
// subagent runs here unchanged.
const TOOL_GROUPS: Completion[] = [
  { label: "read", hint: "Read, Glob, Grep — may look, never write" },
  { label: "files", hint: "Read, Write, Edit, Glob, Grep" },
  { label: "web", hint: "WebSearch, WebFetch" },
  { label: "bash", hint: "Bash — arbitrary commands" },
];

const SDK_TOOL_NAMES: Completion[] = [
  { label: "Read", hint: "exact SDK name" },
  { label: "Write", hint: "exact SDK name" },
  { label: "Edit", hint: "exact SDK name" },
  { label: "Glob", hint: "exact SDK name" },
  { label: "Grep", hint: "exact SDK name" },
  { label: "Bash", hint: "exact SDK name" },
  { label: "WebSearch", hint: "exact SDK name" },
  { label: "WebFetch", hint: "exact SDK name" },
];

const METHODS: Completion[] = ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ label: m }));

const TRIGGERS: Completion[] = [
  { label: "manual", hint: "a person presses Run" },
  { label: "schedule", hint: "cron — needs schedule: and timezone:" },
  { label: "webhook", hint: "fires on POST to its hook URL" },
];

const OKF_TYPES: Completion[] = [
  { label: "Fact" },
  { label: "Decision" },
  { label: "Preference" },
  { label: "Reference" },
  { label: "Runbook" },
  { label: "Price List" },
  { label: "Policy" },
];

const TRANSPORTS: Completion[] = [
  { label: "http", hint: "an API — needs base:" },
  { label: "script", hint: "an executable — needs run:" },
  { label: "mcp", hint: "an MCP server — needs command: or url:" },
];


const CRON: Completion[] = [
  { label: "0 6 * * MON", hint: "Mondays at 6am" },
  { label: "0 * * * *", hint: "hourly" },
  { label: "0 9 * * *", hint: "daily at 9am" },
  { label: "*/15 * * * *", hint: "every 15 minutes" },
];

const TIMEZONES: Completion[] = [
  "Australia/Sydney",
  "Australia/Perth",
  "UTC",
  "Europe/London",
  "America/New_York",
].map((t) => ({ label: t }));

// Which frontmatter fields belong to which kind of file. Offering a field is
// the cheapest documentation there is: you learn the format by writing it.
const FIELDS: Record<string, Completion[]> = {
  agent: [
    { label: "name", insert: "name: ", hint: "required" },
    { label: "description", insert: "description: ", hint: "required — what it does, and when" },
    { label: "model", insert: "model: default" },
    { label: "effort", insert: "effort: high", hint: "how hard it thinks" },
    { label: "tools", insert: "tools:\n  - files", hint: "what the runtime gives it" },
    { label: "use", insert: "use:\n  - ", hint: "tools you built" },
    { label: "secrets", insert: "secrets:\n  - ", hint: "credentials it may spend" },
    { label: "skills", insert: "skills:\n  - ", hint: "allowlist; omit to inherit all" },
    { label: "scripts", insert: "scripts:\n  - name: \n    run: \n    description: " },
    { label: "runtime", insert: "runtime:\n  python: \"3\"\n  packages: []" },
    { label: "mcpServers", insert: "mcpServers:\n  " },
    { label: "permissionMode", insert: "permissionMode: plan", hint: "plan = read-only" },
    { label: "disallowedTools", insert: "disallowedTools:\n  - " },
    {
      label: "provider",
      insert: "provider:\n  base_url: https://\n  token: ${PROVIDER_TOKEN}",
      hint: "an Anthropic-compatible endpoint — omit for Anthropic",
    },
    {
      label: "provider.models",
      insert: "provider:\n  base_url: https://\n  token: ${PROVIDER_TOKEN}\n  models:\n    fast: \n    default: \n    max: ",
      hint: "what this gateway calls each tier",
    },
    {
      label: "provider.headers",
      insert: "provider:\n  base_url: https://\n  token: ${PROVIDER_TOKEN}\n  headers:\n    X-Title: foldrun",
      hint: "gateway-specific settings — ${SECRET} resolves server-side",
    },
  ],
  tool: [
    { label: "name", insert: "name: " },
    { label: "description", insert: "description: " },
    { label: "transport", insert: "transport: http", hint: "http | script | mcp" },
    { label: "base", insert: "base: https://", hint: "http tools" },
    { label: "methods", insert: "methods: [GET]" },
    {
      label: "headers",
      insert: "headers:\n  Authorization: Bearer ${TOKEN_NAME}",
      hint: "bearer token — ${SECRET} resolves server-side",
    },
    {
      label: "headers (api key)",
      insert: "headers:\n  X-API-Key: ${API_KEY}",
      hint: "api key in a header",
    },
    {
      label: "headers (basic)",
      insert: "headers:\n  Authorization: Basic ${BASIC_CREDENTIALS}",
      hint: "store base64(user:pass) as the secret",
    },
    {
      label: "query (api key)",
      insert: "query:\n  api_key: ${API_KEY}",
      hint: "api key as a query parameter",
    },
    {
      label: "graphql",
      insert:
        "base: https://api.example.com\nmethods: [POST]\nheaders:\n  Authorization: Bearer ${TOKEN_NAME}",
      hint: "POST the query as the body to /graphql",
    },
    { label: "query", insert: "query:\n  key: ${API_KEY}" },
    { label: "run", insert: "run: workspace/scripts/", hint: "script tools" },
    { label: "args", insert: "args:\n  name: what it is" },
    { label: "command", insert: "command: npx", hint: "mcp over stdio" },
    { label: "url", insert: "url: https://", hint: "mcp over http" },
  ],
  flow: [
    { label: "name", insert: "name: " },
    { label: "trigger", insert: "trigger: manual" },
    { label: "schedule", insert: "schedule: \"0 6 * * MON\"" },
    { label: "timezone", insert: "timezone: Australia/Sydney" },
    { label: "model", insert: "model: fast", hint: "every step, unless the step says" },
    { label: "effort", insert: "effort: high", hint: "every step, unless the step says" },
  ],
  evalFile: [
    { label: "name", insert: "name: " },
    { label: "agent", insert: "agent: " },
    { label: "flow", insert: "flow: ", hint: "instead of agent:" },
    { label: "model", insert: "model: fast", hint: "the judge's model" },
    { label: "effort", insert: "effort: low", hint: "the judge's effort" },
  ],
  // memory/ and knowledge/ are OKF bundles — `type` is the spec's one
  // required field, the rest are its v0.2 provenance and lifecycle signals.
  note: [
    { label: "type", insert: "type: Fact", hint: "required by OKF" },
    // `title`, not `name`: a bundle carries the format's fields and no
    // dialect of ours. `name` is still read from older files, never written.
    { label: "title", insert: "title: ", hint: "the human-readable label" },
    { label: "description", insert: "description: " },
    { label: "resource", insert: "resource: ", hint: "URI of the thing this describes" },
    { label: "status", insert: "status: stable", hint: "draft | stable | deprecated" },
    { label: "stale_after", insert: "stale_after: ", hint: "YYYY-MM-DD — stale on or after" },
    { label: "tags", insert: "tags: []" },
    {
      label: "verified",
      insert: "verified:\n  - by: human:\n    at: ",
      hint: "human: makes it human-reviewed",
    },
    { label: "sources", insert: "sources:\n  - resource: ", hint: "resource: is required in an entry" },
    {
      label: "usage_window",
      insert: "usage_window:\n  from: \n  to: ",
      hint: "frames every usage_count in sources",
    },
    { label: "generated", insert: "generated:\n  by: human:\n  at: " },
  ],
  skill: [
    { label: "name", insert: "name: " },
    { label: "description", insert: "description: " },
    { label: "when", insert: "when:\n  - ", hint: "tags — load only on matching runs" },
  ],
};

export type FileKind = keyof typeof FIELDS;

export function fileKind(path: string): FileKind {
  // AGENTS.md configures the whole workspace, so it takes the agent fields.
  if (/(^|\/)AGENTS\.md$/.test(path) || path === "project.md") return "agent";
  if (/(^|\/)agent\.md$/.test(path)) return "agent";
  if (/(^|\/)SKILL\.md$/.test(path) || /^skills\//.test(path)) return "skill";
  if (/(^|\/)tools\//.test(path)) return "tool";
  if (/^flows\//.test(path)) return "flow";
  if (/^evals\//.test(path)) return "evalFile";
  return "note";
}

/** Assertion keywords for eval case bodies. */
const ASSERTIONS: Completion[] = [
  { label: "contains", hint: "text must appear" },
  { label: "not-contains", hint: "text must not appear" },
  { label: "matches", hint: "regular expression" },
  { label: "file", hint: "path exists and is non-empty" },
  { label: "run", hint: "shell command exits 0" },
  { label: "judge", hint: "a model grades against this sentence" },
];

const STEP_OPTIONS: Completion[] = [
  { label: "when", insert: "when: ", hint: "skip unless prior results mention it" },
  { label: "retry", insert: "retry: 1" },
  { label: "timeout", insert: "timeout: 300", hint: "seconds" },
  { label: "verify", insert: "verify: ", hint: "shell command must exit 0" },
  { label: "model", insert: "model: fast" },
  { label: "effort", insert: "effort: high", hint: "this step only" },
  { label: "approve", insert: "approve: true", hint: "pause for a human" },
];

// Header and query-parameter names, for the indented lines under `headers:`
// and `query:`. Each inserts a working pair, because a bare key teaches
// nothing about where the credential goes.
const HEADER_NAMES: Completion[] = [
  { label: "Authorization", insert: "Authorization: Bearer ${TOKEN_NAME}", hint: "bearer token" },
  { label: "X-API-Key", insert: "X-API-Key: ${API_KEY}", hint: "api key header" },
  { label: "X-Auth-Token", insert: "X-Auth-Token: ${TOKEN_NAME}" },
  { label: "api-key", insert: "api-key: ${API_KEY}", hint: "Azure, Anthropic" },
  { label: "x-api-key", insert: "x-api-key: ${API_KEY}", hint: "Anthropic, AWS API Gateway" },
  { label: "Content-Type", insert: "Content-Type: application/json" },
  { label: "Accept", insert: "Accept: application/json" },
  { label: "Accept-Language", insert: "Accept-Language: en-AU" },
  { label: "User-Agent", insert: "User-Agent: foldrun" },
  { label: "X-Api-Version", insert: "X-Api-Version: " },
  { label: "anthropic-version", insert: "anthropic-version: 2023-06-01" },
  { label: "developer-token", insert: "developer-token: ${DEVELOPER_TOKEN}", hint: "Google Ads" },
  { label: "login-customer-id", insert: "login-customer-id: ${ADS_CUSTOMER_ID}", hint: "Google Ads" },
  { label: "X-Request-Id", insert: "X-Request-Id: " },
  { label: "X-Correlation-Id", insert: "X-Correlation-Id: " },
  { label: "Idempotency-Key", insert: "Idempotency-Key: ", hint: "Stripe and similar" },
  { label: "Stripe-Version", insert: "Stripe-Version: " },
  { label: "OpenAI-Organization", insert: "OpenAI-Organization: ${OPENAI_ORG}" },
  { label: "X-GitHub-Api-Version", insert: "X-GitHub-Api-Version: 2022-11-28" },
  { label: "Cookie", insert: "Cookie: ${SESSION_COOKIE}" },
];

const QUERY_NAMES: Completion[] = [
  { label: "api_key", insert: "api_key: ${API_KEY}" },
  { label: "key", insert: "key: ${API_KEY}" },
  { label: "token", insert: "token: ${TOKEN_NAME}" },
];

// Prefix matches first, then anything containing the query — so "key" finds
// `X-API-Key` and "auth" finds `Authorization`, without burying exact starts.
const filter = (items: Completion[], query: string) => {
  if (!query) return items.slice(0, 16);
  const q = query.toLowerCase();
  const starts = items.filter((i) => i.label.toLowerCase().startsWith(q));
  const contains = items.filter(
    (i) => !i.label.toLowerCase().startsWith(q) && i.label.toLowerCase().includes(q),
  );
  return [...starts, ...contains].slice(0, 16);
};

/**
 * What can go at the cursor?
 * @returns null when nothing sensible can be suggested.
 */
export function completionsAt(
  path: string,
  text: string,
  cursor: number,
  vocab: Vocabulary,
): CompletionContext | null {
  const before = text.slice(0, cursor);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);
  const kind = fileKind(path);

  // 1. [[wikilink]] — agents and flows, anywhere.
  const open = before.lastIndexOf("[[");
  if (open !== -1 && !before.slice(open).includes("]]") && !before.slice(open).includes("\n")) {
    const query = before.slice(open + 2);
    const items: Completion[] = [
      ...vocab.agents.map((a) => ({ label: a, hint: "agent" })),
      ...vocab.flows.map((f) => ({ label: `flow:${f}`, hint: "flow" })),
      // Knowledge, memory and files join the same bracket: in a flow the
      // first link on a step line stays structural (the parser only reads
      // that one), and everywhere else the runner resolves these to the
      // real relative path before the model sees the prompt.
      ...(vocab.docs ?? []).map((d) => ({ label: d.name, hint: d.hint })),
    ];
    return { from: open + 2, query, items: filter(items, query), title: "Link" };
  }

  // 2. ${SECRET} — inside a header, env or query value.
  const dollar = before.lastIndexOf("${");
  if (dollar !== -1 && !before.slice(dollar).includes("}") && !before.slice(dollar).includes("\n")) {
    const query = before.slice(dollar + 2);
    return {
      from: dollar + 2,
      query,
      items: filter(
        vocab.secrets.map((s) => ({ label: s, insert: `${s}}`, hint: "secret" })),
        query,
      ),
      title: "Secret — resolved server-side, never shown to the model",
    };
  }

  // 3. Inside an unclosed inline list — `methods: [GET, ` — offer what hasn't
  //    been chosen yet, one at a time. Fixed combinations were the wrong
  //    model: nobody wants a menu of every permutation, they want to add the
  //    next verb.
  const inlineList = line.match(/^(\s*)([a-zA-Z_]+):\s*\[([^\]]*)$/);
  if (inlineList) {
    const [, , key, inside] = inlineList;
    // The inline and block forms of a list are the same field — `use: [a, b]`
    // and `use:\n  - a` must complete identically, or the shorthand people
    // actually write is the one the editor abandons.
    const options: Record<string, Completion[]> = {
      methods: METHODS,
      tags: [],
      tools: [...TOOL_GROUPS, ...vocab.tools.map((t) => ({ label: t, hint: "your tool" })), ...SDK_TOOL_NAMES],
      use: vocab.tools.map((t) => ({ label: t, hint: "tool" })),
      secrets: vocab.secrets.map((se) => ({ label: se, hint: "secret" })),
      skills: vocab.skills.map((sk) => ({ label: sk, hint: "skill" })),
      agents: vocab.agents.map((a) => ({ label: a, hint: "consult mid-run" })),
      delegate: vocab.agents.map((a) => ({ label: a, hint: "agent" })),
    };
    const all = options[key];
    if (all) {
      const lastComma = inside.lastIndexOf(",");
      const partial = inside.slice(lastComma + 1).trim();
      const chosen = inside
        .slice(0, lastComma + 1)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      const remaining = all.filter((m) => !chosen.includes(m.label.toUpperCase()));
      const items = filter(remaining, partial).map((m) => ({
        ...m,
        // Close the list when it's the last one left, so the common case is
        // one keystroke rather than two.
        insert: remaining.length === 1 ? `${m.label}]` : m.label,
      }));
      if (items.length) {
        return {
          from: cursor - partial.length,
          query: partial,
          items,
          title: chosen.length
            ? `${key} — ${chosen.join(", ")} chosen; add another or type ]`
            : `${key} — pick one, then comma for the next`,
        };
      }
    }
  }

  // 4. `key: value` — the value side of a known field.
  const kv = line.match(/^(\s*)([a-zA-Z_]+):\s*(\S*)$/);
  if (kv) {
    const [, , key, partial] = kv;
    const from = cursor - partial.length;
    const byKey: Record<string, Completion[]> = {
      model: [...MODELS, ...(vocab.models ?? []).map((m) => ({ label: m.id, hint: m.hint }))],
      effort: EFFORTS,
      // `type:` is OKF's field and only OKF's — an open vocabulary describing
      // what a piece of knowledge is about, on knowledge and memory files.
      // Nothing else declares what it is: an agent or a flow is identified by
      // the directory it sits in. Tools say how they connect in `transport:`,
      // which is a different question again.
      //
      // Types already in this workspace first — they're the ones that keep the
      // index from splitting into near-duplicate headings — then our defaults.
      type: [
        ...vocab.types.map((x) => ({ label: x, hint: "used here" })),
        ...OKF_TYPES.filter((d) => !vocab.types.includes(d.label)),
      ],
      transport: TRANSPORTS,
      trigger: TRIGGERS,
      schedule: CRON,
      timezone: TIMEZONES,
      agent: vocab.agents.map((a) => ({ label: a })),
      flow: vocab.flows.map((f) => ({ label: f })),
      run: vocab.scripts.map((s) => ({ label: s, hint: "script" })),
      // Before the bracket is open: a starting point. Once it's open, rule 3
      // takes over and adds verbs one at a time.
      methods: [
        { label: "[GET]", hint: "read-only — the default" },
        { label: "[", hint: "build the list yourself" },
        { label: "[GET, POST]" },
        { label: "[POST]", hint: "GraphQL and RPC-style APIs" },
        { label: "[GET, POST, PUT, PATCH, DELETE]", hint: "full CRUD" },
      ],
      status: [
        { label: "stable", hint: "the default" },
        { label: "draft", hint: "not ready to rely on" },
        { label: "deprecated", hint: "kept for history" },
      ],
      verify: [
        { label: "test -s outputs/report.md", hint: "a file was produced" },
        { label: "npm run build" },
      ],
    };
    const items = byKey[key];
    if (items) return { from, query: partial, items: filter(items, partial), title: key };
  }

  // 4. `- item` under a list field — look upward for the field name.
  const listItem = line.match(/^(\s+)-\s*(\S*)$/);
  if (listItem) {
    const partial = listItem[2];
    const from = cursor - partial.length;
    const priorLines = before.slice(0, lineStart).split("\n").reverse();
    const owner = priorLines.find((l) => /^\s*[a-zA-Z_]+:\s*$/.test(l))?.trim().replace(":", "");
    const byOwner: Record<string, Completion[]> = {
      // One list now: built-ins and your own tools are granted the same way.
      // Groups first (they cover most needs), then your own tools — the ones
      // you can't guess — then the exact SDK names.
      tools: [
        ...TOOL_GROUPS,
        ...vocab.tools.map((t) => ({ label: t, hint: "your tool" })),
        ...SDK_TOOL_NAMES,
      ],
      use: vocab.tools.map((t) => ({ label: t, hint: "tool" })),
      secrets: vocab.secrets.map((s) => ({ label: s, hint: "secret" })),
      skills: vocab.skills.map((s) => ({ label: s, hint: "skill" })),
      disallowedTools: [...TOOL_GROUPS, { label: "Bash" }, { label: "Write" }],
      when: [{ label: "schema" }, { label: "urgent" }],
      expect: ASSERTIONS.map((a) => ({ ...a, insert: `${a.label}: ` })),
    };
    const items = owner ? byOwner[owner] : undefined;
    if (items) {
      const titles: Record<string, string> = {
        tools: "tools — built-ins and your own; anything here is granted",
        use: "use — tools defined in this workspace or account",
        secrets: "secrets — resolved server-side, never shown to the model",
        skills: "skills — omit the list entirely to inherit all of them",
      };
      return {
        from,
        query: partial,
        items: filter(items, partial),
        title: titles[owner!] ?? owner!,
      };
    }
  }

  // 5. An indented mapping line under headers:, query: or env: — the credential
  //    goes in the value, so suggest the whole pair rather than the key alone.
  const mapping = line.match(/^(\s+)([A-Za-z][A-Za-z0-9-]*)?$/);
  if (mapping && kind !== "flow") {
    const partial = mapping[2] ?? "";
    const priorLines = before.slice(0, lineStart).split("\n").reverse();
    const owner = priorLines
      .find((l) => /^\s*[a-zA-Z_]+:\s*$/.test(l))
      ?.trim()
      .replace(":", "");
    const byOwner: Record<string, Completion[]> = {
      headers: HEADER_NAMES,
      query: QUERY_NAMES,
      env: QUERY_NAMES,
    };
    const items = owner ? byOwner[owner] : undefined;
    if (items) {
      const matched = filter(items, partial);
      // A header we don't know is still a header. Offer the pair shape for
      // whatever was typed, so an unrecognised name never means no help.
      const custom: Completion[] =
        partial.length >= 2 && !matched.some((m) => m.label.toLowerCase() === partial.toLowerCase())
          ? [
              {
                label: partial,
                insert: `${partial}: \${SECRET_NAME}`,
                hint: "custom — value takes a ${SECRET}",
              },
            ]
          : [];
      return {
        from: cursor - partial.length,
        query: partial,
        items: [...matched, ...custom],
        title: `${owner} — the value is where the credential goes`,
      };
    }
  }

  // 6. An indented option under a flow step.
  if (kind === "flow" && /^\s+[a-z]*$/.test(line) && line.trim().length >= 0) {
    const partial = line.trim();
    return {
      from: cursor - partial.length,
      query: partial,
      items: filter(STEP_OPTIONS, partial),
      title: "Step option",
    };
  }

  // 7. A bare word at the start of a frontmatter line — offer the fields for
  //    this kind of file. This is where you learn the format by writing it.
  const fmEnd = text.indexOf("\n---", text.indexOf("---") + 3);
  const inFrontmatter = text.startsWith("---") && (fmEnd === -1 || cursor <= fmEnd);
  if (inFrontmatter && /^[a-zA-Z_]*$/.test(line)) {
    const from = cursor - line.length;
    return { from, query: line, items: filter(FIELDS[kind], line), title: `${kind} fields` };
  }

  return null;
}
