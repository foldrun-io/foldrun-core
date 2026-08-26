// Built-in tools: platform-maintained definitions a tenant assigns to their
// account library or one workspace with a click, then wires into an agent
// with the shown snippet. Assignment is a copy, deliberately: the tenant's
// library is theirs — a later platform upgrade never silently changes what
// their agents run. Nothing here is granted to any agent by default; the
// grant is in the agent's own markdown (`scripts:` for a script, `use:` for
// an API tool), where a reviewer sees it.
//
// Two kinds share the shelf. A script is code the runner executes; an API
// tool is a markdown definition the platform turns into one HTTP tool,
// credentials resolved from the vault server-side — the agent never sees
// the key, only the capability. API entries default to the least dangerous
// method set that makes the tool worth shipping: read-only unless writing
// is the entire point (email that cannot send is not email).

import { writeLibraryFile } from "./library.ts";
import { writeWorkspaceFile } from "./store.ts";

export interface GalleryTool {
  name: string;
  /** Which library shelf this installs onto — and which grant wires it in. */
  kind: "scripts" | "tools";
  title: string;
  description: string;
  /** Path within that kind's library dir / workspace dir. */
  file: string;
  /** Ready-made agent.md snippet, account-scope spelling. */
  snippet: string;
  content: string;
  /**
   * A script's tool-definition wrapper, installed onto the tools shelf
   * beside the code — so a script is granted the same way an API is:
   * `use: [name]`, with the args and timeout living in the definition
   * rather than pasted into every agent. Written with the account-scope
   * `run:` path; a workspace install rewrites it to the workspace prefix,
   * because the wrapper travels with the code it points at.
   */
  wrapper?: { file: string; content: string };
}

export const GALLERY: GalleryTool[] = [
  {
    name: "browser",
    kind: "scripts",
    title: "Headless browser",
    description:
      "Fetch a page the way a browser sees it — JavaScript runs, content renders. " +
      "For client-rendered directories and portals a plain fetch reads as an empty shell.",
    file: "fetch-rendered.mjs",
    snippet: "use: [browser]",
    wrapper: { file: "browser.md", content: "---\ntransport: script\nname: browser\ndescription: >\n  Open a page in a real browser (JavaScript runs) and return what a person\n  would see. Use when a fetch returns an empty shell or a \"checking your\n  browser\" page. mode=links lists every link on the page.\nrun: account/scripts/fetch-rendered.mjs\nargs:\n  url: The page to open (https://\u2026)\n  wait_for: Optional CSS selector to wait for\n  mode: text | html | links (default text)\ntimeout: 120\n---\n\nThe headless browser as a tool: the agent calls it by name with typed\narguments and never composes a command line. An agent opts in with:\n\n```yaml\nuse: [browser]\n```\n\nThe code is `fetch-rendered.mjs` on the scripts shelf, installed together\nwith this definition. Pairs with the `websearch` tool: search finds the\npage, the browser reads it rendered.\n" },
    content: "#!/usr/bin/env node\n// Fetch a page the way a browser sees it: run the JavaScript, wait for the\n// content, return text. For the sites WebFetch can't read \u2014 client-rendered\n// directories, portals behind \"checking your browser\" interstitials.\n//\n//   --url       the page to open (required)\n//   --wait_for  a CSS selector to wait for before reading (optional)\n//   --mode      text | html | links   (default text)\n//\n// Chromium's own sandbox is off: the run container/gVisor is the sandbox\n// here, and the two fight. Output is capped \u2014 a page that renders to more\n// is a page to read in pieces via wait_for and specific URLs.\n\nimport { parseArgs } from \"node:util\";\nimport { createRequire } from \"node:module\";\n\n// Playwright is installed globally in the runner image; ESM import() does\n// not consult global paths (NODE_PATH is CJS-only), so resolve it via a\n// require anchored at the global modules directory.\nconst { chromium } = createRequire(\"/usr/local/lib/node_modules/\")(\"playwright\");\n\nconst MAX_CHARS = 18_000;\nconst { values } = parseArgs({\n  options: {\n    url: { type: \"string\" },\n    wait_for: { type: \"string\" },\n    mode: { type: \"string\", default: \"text\" },\n  },\n});\nif (!values.url || !/^https?:\\/\\//.test(values.url)) {\n  console.error(\"need --url https://\u2026\");\n  process.exit(1);\n}\n\nconst browser = await chromium.launch({\n  args: [\"--no-sandbox\", \"--disable-dev-shm-usage\", \"--disable-gpu\"],\n});\ntry {\n  const page = await browser.newPage({\n    // A believable desktop UA \u2014 the point is rendering, not disguise, but\n    // the default HeadlessChrome UA gets walled by the exact sites that\n    // need a browser in the first place.\n    userAgent:\n      \"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\",\n    viewport: { width: 1366, height: 900 },\n  });\n  await page.goto(values.url, { waitUntil: \"domcontentloaded\", timeout: 45_000 });\n  if (values.wait_for) {\n    await page.waitForSelector(values.wait_for, { timeout: 20_000 }).catch(() => {\n      console.error(`note: selector \"${values.wait_for}\" never appeared; returning what rendered`);\n    });\n  } else {\n    await page.waitForLoadState(\"networkidle\", { timeout: 15_000 }).catch(() => {});\n  }\n\n  let out;\n  if (values.mode === \"html\") {\n    out = await page.content();\n  } else if (values.mode === \"links\") {\n    const links = await page.$$eval(\"a[href]\", (as) =>\n      as.map((a) => `${(a.textContent ?? \"\").trim().replaceAll(/\\s+/g, \" \")} -> ${a.href}`)\n        .filter((l) => !l.startsWith(\" ->\")),\n    );\n    out = [...new Set(links)].join(\"\\n\");\n  } else {\n    out = await page.evaluate(() => document.body?.innerText ?? \"\");\n  }\n  out = out.trim();\n  if (out.length > MAX_CHARS) {\n    out = out.slice(0, MAX_CHARS) + `\\n\u2026[truncated at ${MAX_CHARS} chars \u2014 narrow the page or use wait_for]`;\n  }\n  console.log(out || \"[page rendered empty]\");\n} finally {\n  await browser.close();\n}\n",
  },
  {
    name: "email",
    kind: "tools",
    title: "Email (Resend)",
    description: "Send transactional email. POST /emails with {from, to, subject, text}. Needs the RESEND_API_KEY connection; until your domain is verified in Resend, send from onboarding@resend.dev.",
    file: "email.md",
    snippet: "use: [email]",
    content: "---\ntransport: http\nname: email\ndescription: Send transactional email via Resend. POST /emails with {from, to, subject, text}.\nbase: https://api.resend.com\nmethods: [POST]\nheaders:\n  Authorization: Bearer ${RESEND_API_KEY}\n  Content-Type: application/json\n---\n\nEmail delivery for agents. An agent opts in with:\n\n```yaml\nuse: [email]\n```\n\nThe key is the `RESEND_API_KEY` connection; until it is set, calls fail\nwith a clear missing-secret message. Send from `onboarding@resend.dev`\nuntil your domain is verified in Resend.\n",
  },
  {
    name: "slack",
    kind: "tools",
    title: "Slack messages",
    description: "Post to Slack channels. POST /api/chat.postMessage with {channel, text}. Needs the SLACK_BOT_TOKEN connection (a bot token with chat:write, invited to the channel).",
    file: "slack.md",
    snippet: "use: [slack]",
    content: "---\ntransport: http\nname: slack\ndescription: >\n  Post a message to Slack. POST /api/chat.postMessage with {channel, text}.\n  channel is a name like #alerts or a channel id.\nbase: https://slack.com\nmethods: [POST]\nheaders:\n  Authorization: Bearer ${SLACK_BOT_TOKEN}\n  Content-Type: application/json\n---\n\nSlack for agents \u2014 notifications, digests, \"the run finished\" messages.\nAn agent opts in with:\n\n```yaml\nuse: [slack]\n```\n\nThe key is the `SLACK_BOT_TOKEN` connection: a bot token (xoxb-\u2026) with\nthe `chat:write` scope, and the bot must be invited to any channel it\nposts to.\n",
  },
  {
    name: "github",
    kind: "tools",
    title: "GitHub",
    description: "Read repos, issues and PRs; open issues and comment. GET and POST on api.github.com. Needs the GITHUB_TOKEN connection (a fine-grained token scoped to the repos the agent should reach).",
    file: "github.md",
    snippet: "use: [github]",
    content: "---\ntransport: http\nname: github\ndescription: >\n  The GitHub API. GET /repos/{owner}/{repo}/issues to read, POST to open;\n  same shape for comments and pulls. Paths are the standard REST v3 API.\nbase: https://api.github.com\nmethods: [GET, POST]\nheaders:\n  Authorization: Bearer ${GITHUB_TOKEN}\n  Accept: application/vnd.github+json\n  X-GitHub-Api-Version: \"2022-11-28\"\n---\n\nGitHub for agents \u2014 triage, changelogs, issue filing. An agent opts in with:\n\n```yaml\nuse: [github]\n```\n\nThe key is the `GITHUB_TOKEN` connection. Use a fine-grained personal\naccess token scoped to only the repositories the agent should reach \u2014\nthe tool can POST, so the token decides the blast radius.\n",
  },
  {
    name: "stripe",
    kind: "tools",
    title: "Stripe (read-only)",
    description: "Read customers, payments, subscriptions and invoices. GET only, deliberately \u2014 reporting, not refunds. Needs the STRIPE_API_KEY connection; use a restricted key with read-only scopes.",
    file: "stripe.md",
    snippet: "use: [stripe]",
    content: "---\ntransport: http\nname: stripe\ndescription: >\n  Read Stripe data. GET /v1/customers, /v1/charges, /v1/subscriptions,\n  /v1/invoices \u2014 standard Stripe REST paths, list endpoints take ?limit=.\nbase: https://api.stripe.com\nmethods: [GET]\nheaders:\n  Authorization: Bearer ${STRIPE_API_KEY}\n---\n\nStripe for agents \u2014 revenue summaries, churn checks, \"who paid this week\".\nRead-only by construction: the tool allows GET and nothing else, so no\nagent can refund, charge or cancel through it. An agent opts in with:\n\n```yaml\nuse: [stripe]\n```\n\nThe key is the `STRIPE_API_KEY` connection. Match the tool's shape with\na restricted key (read-only scopes) rather than a full secret key \u2014 the\nmethod allowlist protects against the agent, the key against everyone.\n",
  },
  {
    name: "websearch",
    kind: "tools",
    title: "Web search (Brave)",
    description: "Search the web. GET /res/v1/web/search?q=\u2026 returns titles, URLs and snippets. Needs the BRAVE_API_KEY connection (free tier available).",
    file: "websearch.md",
    snippet: "use: [websearch]",
    content: "---\ntransport: http\nname: websearch\ndescription: >\n  Search the web via the Brave Search API. GET /res/v1/web/search with\n  ?q=your+query; add &count=10 for more results.\nbase: https://api.search.brave.com\nmethods: [GET]\nheaders:\n  X-Subscription-Token: ${BRAVE_API_KEY}\n  Accept: application/json\n---\n\nWeb search for agents \u2014 current facts, competitor pages, \"find the docs\nfor X\". Pairs with the browser script from this gallery: search finds the\npage, the browser reads it rendered. An agent opts in with:\n\n```yaml\nuse: [websearch]\n```\n\nThe key is the `BRAVE_API_KEY` connection \u2014 free tier at\nbrave.com/search/api.\n",
  },
];

/**
 * A gallery entry as the starting content for a *newly named* document —
 * what "New tool → start from Email (Resend)" writes.
 *
 * Distinct from installing it: installing keeps the platform's name and file
 * so upgrades and the installed-badge line up, while this is the author
 * taking a working definition and making it theirs. So the name is rewritten
 * everywhere it appears — the frontmatter, and the `use: [...]` line in the
 * body that would otherwise tell a reader to grant a tool that isn't there.
 *
 * Returns null for an unknown template, so a caller can treat "no template"
 * and "bad template" the same way: fall back to the blank one.
 */
export function galleryTemplate(
  kind: GalleryTool["kind"],
  template: string,
  name: string,
): { file: string; content: string } | null {
  const tool = GALLERY.find((t) => t.name === template && t.kind === kind);
  if (!tool) return null;
  const ext = tool.file.slice(tool.file.lastIndexOf("."));
  const content = tool.content
    .replace(/^name: .*$/m, `name: ${name}`)
    .replaceAll(`use: [${tool.name}]`, `use: [${name}]`);
  return { file: `${name}${ext}`, content };
}

export function galleryTool(name: string): GalleryTool | undefined {
  return GALLERY.find((t) => t.name === name);
}

/** Copy a gallery tool into the account library, or one workspace. The
 *  tool's kind picks the shelf — scripts and API tools land in different
 *  directories, and the runner reads each from its own. */
export function installGalleryTool(tenant: string, name: string, workspace?: string): string {
  const tool = galleryTool(name);
  if (!tool) throw new Error(`no such gallery tool "${name}"`);
  if (workspace) {
    const rel = `${tool.kind}/${tool.file}`;
    writeWorkspaceFile(tenant, workspace, rel, tool.content);
    if (tool.wrapper) {
      writeWorkspaceFile(
        tenant,
        workspace,
        `tools/${tool.wrapper.file}`,
        tool.wrapper.content.replace("run: account/scripts/", "run: workspace/scripts/"),
      );
    }
    return rel;
  }
  writeLibraryFile(tenant, tool.kind, tool.file, tool.content);
  if (tool.wrapper) writeLibraryFile(tenant, "tools", tool.wrapper.file, tool.wrapper.content);
  return tool.file;
}
