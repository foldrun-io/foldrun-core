// Built-in tools: platform-maintained scripts a tenant assigns to their
// account library or one workspace with a click, then wires into an agent
// with the shown snippet. Assignment is a copy, deliberately: the tenant's
// library is theirs — a later platform upgrade never silently changes what
// their agents run. Nothing here is granted to any agent by default; the
// grant is the `scripts:` block in the agent's own markdown, where a
// reviewer sees it.

import { writeLibraryFile } from "./library.ts";
import { writeWorkspaceFile } from "./store.ts";

export interface GalleryTool {
  name: string;
  title: string;
  description: string;
  /** Path within the scripts library / workspace scripts dir. */
  file: string;
  /** Ready-made agent.md snippet, account-scope spelling. */
  snippet: string;
  content: string;
}

export const GALLERY: GalleryTool[] = [
  {
    name: "browser",
    title: "Headless browser",
    description:
      "Fetch a page the way a browser sees it — JavaScript runs, content renders. " +
      "For client-rendered directories and portals a plain fetch reads as an empty shell.",
    file: "fetch-rendered.mjs",
    snippet: "scripts:\n  - name: fetch_rendered\n    run: account/scripts/fetch-rendered.mjs   # or workspace/scripts/\u2026 if installed there\n    description: >\n      Open a page in a real browser (JavaScript runs) and return what a\n      person would see. Use when a fetch returns an empty shell or a\n      \"checking your browser\" page. mode=links lists every link.\n    args:\n      url: The page to open (https://\u2026)\n      wait_for: Optional CSS selector to wait for\n      mode: text | html | links (default text)\n    timeout: 120",
    content: "#!/usr/bin/env node\n// Fetch a page the way a browser sees it: run the JavaScript, wait for the\n// content, return text. For the sites WebFetch can't read \u2014 client-rendered\n// directories, portals behind \"checking your browser\" interstitials.\n//\n//   --url       the page to open (required)\n//   --wait_for  a CSS selector to wait for before reading (optional)\n//   --mode      text | html | links   (default text)\n//\n// Chromium's own sandbox is off: the run container/gVisor is the sandbox\n// here, and the two fight. Output is capped \u2014 a page that renders to more\n// is a page to read in pieces via wait_for and specific URLs.\n\nimport { parseArgs } from \"node:util\";\nimport { createRequire } from \"node:module\";\n\n// Playwright is installed globally in the runner image; ESM import() does\n// not consult global paths (NODE_PATH is CJS-only), so resolve it via a\n// require anchored at the global modules directory.\nconst { chromium } = createRequire(\"/usr/local/lib/node_modules/\")(\"playwright\");\n\nconst MAX_CHARS = 18_000;\nconst { values } = parseArgs({\n  options: {\n    url: { type: \"string\" },\n    wait_for: { type: \"string\" },\n    mode: { type: \"string\", default: \"text\" },\n  },\n});\nif (!values.url || !/^https?:\\/\\//.test(values.url)) {\n  console.error(\"need --url https://\u2026\");\n  process.exit(1);\n}\n\nconst browser = await chromium.launch({\n  args: [\"--no-sandbox\", \"--disable-dev-shm-usage\", \"--disable-gpu\"],\n});\ntry {\n  const page = await browser.newPage({\n    // A believable desktop UA \u2014 the point is rendering, not disguise, but\n    // the default HeadlessChrome UA gets walled by the exact sites that\n    // need a browser in the first place.\n    userAgent:\n      \"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\",\n    viewport: { width: 1366, height: 900 },\n  });\n  await page.goto(values.url, { waitUntil: \"domcontentloaded\", timeout: 45_000 });\n  if (values.wait_for) {\n    await page.waitForSelector(values.wait_for, { timeout: 20_000 }).catch(() => {\n      console.error(`note: selector \"${values.wait_for}\" never appeared; returning what rendered`);\n    });\n  } else {\n    await page.waitForLoadState(\"networkidle\", { timeout: 15_000 }).catch(() => {});\n  }\n\n  let out;\n  if (values.mode === \"html\") {\n    out = await page.content();\n  } else if (values.mode === \"links\") {\n    const links = await page.$$eval(\"a[href]\", (as) =>\n      as.map((a) => `${(a.textContent ?? \"\").trim().replaceAll(/\\s+/g, \" \")} -> ${a.href}`)\n        .filter((l) => !l.startsWith(\" ->\")),\n    );\n    out = [...new Set(links)].join(\"\\n\");\n  } else {\n    out = await page.evaluate(() => document.body?.innerText ?? \"\");\n  }\n  out = out.trim();\n  if (out.length > MAX_CHARS) {\n    out = out.slice(0, MAX_CHARS) + `\\n\u2026[truncated at ${MAX_CHARS} chars \u2014 narrow the page or use wait_for]`;\n  }\n  console.log(out || \"[page rendered empty]\");\n} finally {\n  await browser.close();\n}\n",
  },
];

export function galleryTool(name: string): GalleryTool | undefined {
  return GALLERY.find((t) => t.name === name);
}

/** Copy a gallery tool into the account library, or one workspace's scripts. */
export function installGalleryTool(tenant: string, name: string, workspace?: string): string {
  const tool = galleryTool(name);
  if (!tool) throw new Error(`no such gallery tool "${name}"`);
  if (workspace) {
    const rel = `scripts/${tool.file}`;
    writeWorkspaceFile(tenant, workspace, rel, tool.content);
    return rel;
  }
  writeLibraryFile(tenant, "scripts", tool.file, tool.content);
  return tool.file;
}
