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
    kind: "tools",
    title: "Headless browser",
    description:
      "Open a page the way a browser sees it \u2014 JavaScript runs, content renders \u2014 then drive it: " +
      "click, fill forms, press keys, scroll, screenshot. A named session keeps cookies and logins " +
      "across calls within a run. For client-rendered directories and portals a plain fetch reads as an empty shell.",
    file: "browser/tool.md",
    snippet: "use: [browser]",
    content: "---\ntransport: script\nname: browser\nrun: run.mjs\ndescription: >\n  Open a page in a real browser (JavaScript runs) and return what a person\n  would see \u2014 then, optionally, drive it: click, fill a form, press Enter,\n  pick from a dropdown, scroll, follow a link, take a screenshot. Use when a\n  fetch returns an empty shell or a \"checking your browser\" page, or when\n  the content is behind a search box or a login. mode=links lists every\n  link; mode=screenshot writes outputs/page.png. session keeps cookies\n  between calls so a login done once holds for the rest of the run.\nargs:\n  url: The page to open (https://\u2026)\n  wait_for: Optional CSS selector to wait for before reading or acting\n  mode: text | html | links | screenshot (default text)\n  actions: >-\n    Optional JSON array of steps, run in order after the page loads. Each is\n    one of {\"click\": \"<css selector>\"}, {\"fill\": \"<selector>\", \"text\": \"\u2026\"},\n    {\"press\": \"<selector or empty>\", \"key\": \"Enter\"},\n    {\"select\": \"<selector>\", \"value\": \"\u2026\"}, {\"wait\": \"<selector>\"},\n    {\"wait\": 1500} (milliseconds), {\"goto\": \"https://\u2026\"},\n    {\"screenshot\": \"outputs/<name>.png\"}, {\"scroll\": \"bottom\"}.\n  session: >-\n    Optional session name. Cookies and logins persist in outputs/.browser/<name>\n    across calls within the run, so log in once and keep browsing.\ntimeout: 120\n---\n\nThe headless browser. Pairs with the `websearch` tool: search finds the page,\nthis reads it rendered \u2014 and with `actions` it can get past the search box,\nthe cookie banner or the login form first.\n\nAgents opt in with:\n\n```yaml\nuse: [browser]\n```\n\nRead a page (the original shape; nothing changed for callers that only pass\n`url`):\n\n```text\nbrowser(url=\"https://example.com/directory\", wait_for=\".listing\")\n```\n\nSearch a site, then read the results:\n\n```text\nbrowser(url=\"https://example.com\",\n        actions='[{\"fill\": \"input[name=q]\", \"text\": \"building inspector\"},\n                  {\"press\": \"input[name=q]\", \"key\": \"Enter\"},\n                  {\"wait\": \".results\"}]')\n```\n\nLog in once, keep the session for later calls:\n\n```text\nbrowser(url=\"https://portal.example.com/login\", session=\"portal\",\n        actions='[{\"fill\": \"#email\", \"text\": \"\u2026\"}, {\"fill\": \"#password\", \"text\": \"\u2026\"},\n                  {\"click\": \"button[type=submit]\"}, {\"wait\": \".dashboard\"}]')\nbrowser(url=\"https://portal.example.com/reports\", session=\"portal\")\n```\n\nEach action's outcome is one line on stderr, so the run log shows what was\ndone to the page. A step that fails stops the rest; the page as it then\nstood is still returned, and the call exits non-zero.\n\nLimits, honestly: JavaScript-heavy single-page apps often render after\n`domcontentloaded`, so give them a `wait_for` selector or a `{\"wait\": 1500}`\nstep before reading. Selectors are CSS, not natural language \u2014 read the page\nwith `mode=html` first when you don't know them. A session directory lives\nunder `outputs/`, which means it is archived with the run and never deployed;\nit also means whatever the login left there (cookies) is in the run's\narchive. Chromium's own sandbox is off \u2014 the run container is the sandbox\nhere, and the two fight. Output is capped at about 18,000 characters; a\npage that renders to more is one to read in pieces via `wait_for` and\nspecific URLs.\n",
    // The program is a file beside its definition, not a fenced block in
    // it. 90 lines of Playwright inside a markdown code fence inside a
    // TypeScript string literal had no linter, no type checker and no way
    // to run it except by installing the gallery entry and calling it.
    wrapper: { file: "browser/run.mjs", content: "#!/usr/bin/env node\n// A driveable headless browser. Open a page the way a person sees it \u2014 the\n// JavaScript runs, the content renders \u2014 then optionally click, type and\n// navigate before reading it. For the sites WebFetch can't read (client-\n// rendered directories, portals behind \"checking your browser\"), and for\n// the ones that need a login or a search box before they show anything.\n//\n//   --url       the page to open (required)\n//   --wait_for  a CSS selector to wait for before reading (optional)\n//   --mode      text | html | links | screenshot   (default text)\n//   --actions   a JSON array of steps run in order after the page loads:\n//                 {\"click\": \"<css selector>\"}\n//                 {\"fill\": \"<selector>\", \"text\": \"\u2026\"}\n//                 {\"press\": \"<selector or empty>\", \"key\": \"Enter\"}\n//                 {\"select\": \"<selector>\", \"value\": \"\u2026\"}\n//                 {\"wait\": \"<selector>\"}  or  {\"wait\": 1500}   (ms)\n//                 {\"goto\": \"https://\u2026\"}\n//                 {\"screenshot\": \"outputs/<name>.png\"}\n//                 {\"scroll\": \"bottom\"}\n//   --session   a name; cookies and logins persist in outputs/.browser/<name>\n//               across calls within the same run\n//\n// Chromium's own sandbox is off: the run container/gVisor is the sandbox\n// here, and the two fight. Output is capped \u2014 a page that renders to more\n// is a page to read in pieces via wait_for and specific URLs.\n\nimport { parseArgs } from \"node:util\";\nimport { createRequire } from \"node:module\";\nimport fs from \"node:fs\";\nimport path from \"node:path\";\n\n// Playwright is installed globally in the runner image; ESM import() does\n// not consult global paths (NODE_PATH is CJS-only), so resolve it via a\n// require anchored at the global modules directory.\nconst { chromium } = createRequire(\"/usr/local/lib/node_modules/\")(\"playwright\");\n\nconst MAX_CHARS = 18_000;\nconst MODES = [\"text\", \"html\", \"links\", \"screenshot\"];\nconst ACTIONS = [\"click\", \"fill\", \"press\", \"select\", \"wait\", \"goto\", \"screenshot\", \"scroll\"];\nconst STEP_TIMEOUT = 20_000;\n\nconst { values } = parseArgs({\n  options: {\n    url: { type: \"string\" },\n    wait_for: { type: \"string\" },\n    mode: { type: \"string\", default: \"text\" },\n    actions: { type: \"string\" },\n    session: { type: \"string\" },\n  },\n});\n\nconst fail = (msg) => {\n  console.error(msg);\n  process.exit(1);\n};\n\nif (!values.url || !/^https?:\\/\\//.test(values.url)) fail(\"need --url https://\u2026\");\nif (!MODES.includes(values.mode)) fail(`mode must be one of ${MODES.join(\" | \")}, not \"${values.mode}\"`);\nif (values.session && !/^[A-Za-z0-9._-]{1,64}$/.test(values.session)) {\n  fail(\"session must be a plain name: letters, digits, dot, dash, underscore\");\n}\n\n// Files this program writes stay under the agent's directory. The container\n// is the real wall; this is the one that produces a readable message.\nconst cwd = fs.realpathSync(process.cwd());\nfunction insideCwd(rel, what) {\n  if (typeof rel !== \"string\" || !rel) throw new Error(`${what} needs a path like outputs/name.png`);\n  const abs = path.resolve(cwd, rel);\n  const back = path.relative(cwd, abs);\n  if (back.startsWith(\"..\") || path.isAbsolute(back)) {\n    throw new Error(`${what} path ${rel} is outside the agent directory`);\n  }\n  return abs;\n}\n\n// Every step is checked before a browser is opened: an unknown action on\n// step 7 should not cost six steps of a real page first.\nfunction parseActions(raw) {\n  if (!raw) return [];\n  let steps;\n  try {\n    steps = JSON.parse(raw);\n  } catch (err) {\n    fail(`actions is not valid JSON: ${err.message}`);\n  }\n  if (!Array.isArray(steps)) fail(\"actions must be a JSON array of steps\");\n  steps.forEach((step, i) => {\n    const n = i + 1;\n    if (!step || typeof step !== \"object\" || Array.isArray(step)) fail(`action ${n} is not an object`);\n    const kind = ACTIONS.find((k) => k in step);\n    if (!kind) {\n      fail(`action ${n} is unknown: ${JSON.stringify(step)} \u2014 known actions: ${ACTIONS.join(\", \")}`);\n    }\n    const v = step[kind];\n    try {\n      if (kind === \"wait\" && typeof v === \"number\") {\n        if (!(v >= 0 && v <= 60_000)) fail(`action ${n}: wait must be 0\u201360000 ms`);\n      } else if (kind === \"press\") {\n        if (typeof v !== \"string\") fail(`action ${n}: press takes a selector or \"\"`);\n        if (step.key !== undefined && typeof step.key !== \"string\") fail(`action ${n}: key must be a string`);\n      } else if (kind === \"scroll\") {\n        if (v !== \"bottom\" && v !== \"top\" && typeof v !== \"number\") {\n          fail(`action ${n}: scroll takes \"bottom\", \"top\" or a number of pixels`);\n        }\n      } else if (typeof v !== \"string\" || !v) {\n        fail(`action ${n}: ${kind} needs a non-empty string`);\n      } else if (kind === \"goto\" && !/^https?:\\/\\//.test(v)) {\n        fail(`action ${n}: goto needs an http(s) URL`);\n      } else if (kind === \"screenshot\") {\n        insideCwd(v, `action ${n}: screenshot`);\n      }\n    } catch (err) {\n      fail(err.message);\n    }\n  });\n  return steps;\n}\n\nasync function runAction(page, step) {\n  const kind = ACTIONS.find((k) => k in step);\n  const v = step[kind];\n  switch (kind) {\n    case \"click\":\n      await page.click(v, { timeout: STEP_TIMEOUT });\n      return `click ${v}`;\n    case \"fill\": {\n      const text = String(step.text ?? \"\");\n      await page.fill(v, text, { timeout: STEP_TIMEOUT });\n      return `fill ${v} (${text.length} chars)`;\n    }\n    case \"press\": {\n      const key = step.key || \"Enter\";\n      if (v) await page.press(v, key, { timeout: STEP_TIMEOUT });\n      else await page.keyboard.press(key);\n      return `press ${key}${v ? ` on ${v}` : \"\"}`;\n    }\n    case \"select\":\n      await page.selectOption(v, String(step.value ?? \"\"), { timeout: STEP_TIMEOUT });\n      return `select ${v} = ${step.value}`;\n    case \"wait\":\n      if (typeof v === \"number\") {\n        await page.waitForTimeout(v);\n        return `wait ${v}ms`;\n      }\n      await page.waitForSelector(v, { timeout: STEP_TIMEOUT });\n      return `wait ${v} appeared`;\n    case \"goto\":\n      await page.goto(v, { waitUntil: \"domcontentloaded\", timeout: 45_000 });\n      return `goto ${v}`;\n    case \"screenshot\": {\n      const abs = insideCwd(v, \"screenshot\");\n      fs.mkdirSync(path.dirname(abs), { recursive: true });\n      await page.screenshot({ path: abs, fullPage: true });\n      return `screenshot -> ${path.relative(cwd, abs)}`;\n    }\n    case \"scroll\":\n      if (v === \"bottom\") await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));\n      else if (v === \"top\") await page.evaluate(() => window.scrollTo(0, 0));\n      else await page.evaluate((px) => window.scrollBy(0, px), v);\n      await page.waitForTimeout(500);\n      return `scroll ${v}`;\n    default:\n      throw new Error(`unknown action ${JSON.stringify(step)}`);\n  }\n}\n\nconst actions = parseActions(values.actions);\n\nconst launchArgs = [\"--no-sandbox\", \"--disable-dev-shm-usage\", \"--disable-gpu\"];\nconst contextOptions = {\n  // A believable desktop UA \u2014 the point is rendering, not disguise, but\n  // the default HeadlessChrome UA gets walled by the exact sites that\n  // need a browser in the first place.\n  userAgent:\n    \"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\",\n  viewport: { width: 1366, height: 900 },\n};\n\n// A session is a Chromium profile directory under outputs/, so cookies and\n// logins survive from one call to the next within a run \u2014 and the directory\n// is archived with the run's outputs, never deployed anywhere.\nlet browser = null;\nlet context;\nif (values.session) {\n  const profile = path.join(cwd, \"outputs\", \".browser\", values.session);\n  fs.mkdirSync(profile, { recursive: true });\n  context = await chromium.launchPersistentContext(profile, {\n    headless: true,\n    args: launchArgs,\n    ...contextOptions,\n  });\n  console.error(`session ${values.session}: profile at ${path.relative(cwd, profile)}`);\n} else {\n  browser = await chromium.launch({ args: launchArgs });\n  context = await browser.newContext(contextOptions);\n}\n\nlet failed = false;\ntry {\n  const page = context.pages()[0] ?? (await context.newPage());\n  await page.goto(values.url, { waitUntil: \"domcontentloaded\", timeout: 45_000 });\n  if (values.wait_for) {\n    await page.waitForSelector(values.wait_for, { timeout: STEP_TIMEOUT }).catch(() => {\n      console.error(`note: selector \"${values.wait_for}\" never appeared; continuing with what rendered`);\n    });\n  } else {\n    await page.waitForLoadState(\"networkidle\", { timeout: 15_000 }).catch(() => {});\n  }\n\n  // One line per action on stderr, so the run's log says what was done to\n  // the page and not only what came back from it.\n  for (const [i, step] of actions.entries()) {\n    try {\n      const done = await runAction(page, step);\n      await page.waitForLoadState(\"domcontentloaded\", { timeout: 5_000 }).catch(() => {});\n      console.error(`action ${i + 1}: ${done} \u2014 ok`);\n    } catch (err) {\n      console.error(`action ${i + 1}: ${JSON.stringify(step)} \u2014 failed: ${err.message.split(\"\\n\")[0]}`);\n      console.error(\"stopping here; the output below is the page as it stood\");\n      failed = true;\n      break;\n    }\n  }\n\n  let out;\n  if (values.mode === \"screenshot\") {\n    const abs = path.join(cwd, \"outputs\", \"page.png\");\n    fs.mkdirSync(path.dirname(abs), { recursive: true });\n    await page.screenshot({ path: abs, fullPage: true });\n    out = `outputs/page.png\\n${await page.title()} \u2014 ${page.url()}`;\n  } else if (values.mode === \"html\") {\n    out = await page.content();\n  } else if (values.mode === \"links\") {\n    const links = await page.$$eval(\"a[href]\", (as) =>\n      as.map((a) => `${(a.textContent ?? \"\").trim().replaceAll(/\\s+/g, \" \")} -> ${a.href}`)\n        .filter((l) => !l.startsWith(\" ->\")),\n    );\n    out = [...new Set(links)].join(\"\\n\");\n  } else {\n    out = await page.evaluate(() => document.body?.innerText ?? \"\");\n  }\n  out = out.trim();\n  if (out.length > MAX_CHARS) {\n    out = out.slice(0, MAX_CHARS) + `\\n\u2026[truncated at ${MAX_CHARS} chars \u2014 narrow the page or use wait_for]`;\n  }\n  console.log(out || \"[page rendered empty]\");\n} finally {\n  await context.close();\n  if (browser) await browser.close();\n}\nif (failed) process.exit(1);\n" },
  },
  {
    name: "sql",
    kind: "tools",
    title: "SQL over CSV and JSON files",
    description:
      "Run SQL over the CSV and JSON files in the working directory: totals, joins, dedupe, filtering " +
      "across rows. Arithmetic belongs in a query, not in prose. Read-only, stdlib Python, one table per file.",
    file: "sql/tool.md",
    snippet: "use: [sql]",
    content: "---\ntransport: script\nname: sql\nrun: run.py\ndescription: >\n  Run SQL over CSV and JSON files in the working directory. Use it whenever\n  the answer is a number or a subset of rows: totals, averages, counts,\n  joins across two files, de-duplication, filtering, ranking, \"how many\n  leads per city\". Arithmetic belongs in a query, not in prose \u2014 do not add\n  up a column by reading it. Each file becomes a table named after its\n  basename (leads-2026.csv is the table leads_2026). CSV columns are TEXT,\n  so CAST(amount AS REAL) before summing them; JSON numbers stay numbers.\n  Read-only: a single SELECT or WITH statement; anything else is refused.\nargs:\n  query: The SQL \u2014 one SELECT or WITH statement (SQLite dialect)\n  files: Comma-separated .csv / .json paths relative to the working directory, one table each\n  limit: Max rows returned (default 200)\n  format: table | csv | json (default table)\ntimeout: 120\n---\n\nSQL over files. Every file named in `files` is loaded into an in-memory\nSQLite database and the query runs against it, so a join, a GROUP BY or a\nwindow function over two exports is one call rather than a page of prose\nthat gets the total wrong.\n\nAgents opt in with:\n\n```yaml\nuse: [sql]\n```\n\nWhat loads:\n\n- `.csv` \u2014 the header row names the columns, every value is TEXT. Sum or\n  compare with a cast: `SUM(CAST(amount AS REAL))`,\n  `CAST(age AS INTEGER) >= 18`. Leading zeros survive this way, which is\n  the point for phone numbers and postcodes.\n- `.json` \u2014 an array of flat objects, or an object whose first array-valued\n  key holds the rows (`{\"data\": [...]}`). Numbers stay numbers; nested\n  values arrive as JSON text. Joining a JSON number to a CSV column needs\n  the cast on one side: `ON o.person_id = CAST(p.id AS INTEGER)`.\n\nTable names are the file's basename with non-alphanumerics turned into\nunderscores. Column names are used as-is; quote the odd ones:\n`\"First Name\"`.\n\nRead-only by construction: the statement must start with SELECT or WITH,\nSQLite's authorizer denies everything but reads, and the database is\nmemory \u2014 nothing written could persist anyway. Paths must stay inside the\nworking directory; `..` is refused. Output is capped at about 18,000\ncharacters, and `limit` caps the rows (default 200) \u2014 when the note says\nmore rows exist, aggregate or filter rather than raising it.\n\n`run.py` is stdlib Python and runs by hand:\n\n```console\npython3 tools/sql/run.py --files leads.csv --query \"SELECT city, COUNT(*) AS n FROM leads GROUP BY city ORDER BY n DESC\"\n```\n",
    // Stdlib-only Python beside its definition, for the same reason the
    // browser's program is a file: it can be run, linted and tested by hand.
    wrapper: { file: "sql/run.py", content: "#!/usr/bin/env python3\n\"\"\"SQL over CSV and JSON files.\n\nEach file becomes a table in an in-memory SQLite database, named after the\nfile's basename without its extension (non-alphanumerics become underscores:\n\"leads-2026.csv\" is the table leads_2026). The query runs read-only and the\nrows come back as a table, CSV or JSON.\n\n  --query   the SQL (one SELECT or WITH statement; required)\n  --files   comma-separated paths, relative to the working directory\n  --limit   max rows returned (default 200)\n  --format  table | csv | json (default table)\n\nStdlib only: sqlite3, csv, json, argparse. CSV columns are TEXT \u2014 CAST(x AS\nINTEGER) / CAST(x AS REAL) for arithmetic. JSON keeps numbers as numbers.\n\"\"\"\nimport argparse\nimport csv\nimport io\nimport json\nimport os\nimport re\nimport sqlite3\nimport sys\n\nMAX_CHARS = 18_000\nCELL_WIDTH = 60\n\n\ndef fail(msg):\n    print(f\"error: {msg}\", file=sys.stderr)\n    sys.exit(1)\n\n\ndef table_name(path):\n    base = os.path.splitext(os.path.basename(path))[0]\n    name = re.sub(r\"[^A-Za-z0-9]\", \"_\", base)\n    if not name or name[0].isdigit():\n        name = \"t_\" + name\n    return name\n\n\ndef contained(root, rel):\n    \"\"\"The absolute path of `rel` under `root`, or None if it escapes.\"\"\"\n    abs_path = os.path.realpath(os.path.join(root, rel))\n    r = os.path.relpath(abs_path, root)\n    if r == \"..\" or r.startswith(\"..\" + os.sep) or os.path.isabs(r):\n        return None\n    return abs_path\n\n\ndef unique_columns(names):\n    out, seen = [], {}\n    for i, raw in enumerate(names):\n        name = (raw or \"\").strip() or f\"col_{i + 1}\"\n        if name in seen:\n            seen[name] += 1\n            name = f\"{name}_{seen[name]}\"\n        else:\n            seen[name] = 1\n        out.append(name)\n    return out\n\n\ndef load_csv(path):\n    with open(path, encoding=\"utf-8-sig\", errors=\"replace\", newline=\"\") as f:\n        reader = csv.reader(f)\n        try:\n            header = next(reader)\n        except StopIteration:\n            return [], [], []\n        cols = unique_columns(header)\n        rows = []\n        for row in reader:\n            if not row:\n                continue\n            row = row[: len(cols)] + [None] * (len(cols) - len(row))\n            rows.append(row)\n    return cols, rows, [\"TEXT\"] * len(cols)\n\n\ndef json_value(v):\n    if isinstance(v, bool):\n        return int(v)\n    if v is None or isinstance(v, (int, float, str)):\n        return v\n    return json.dumps(v, ensure_ascii=False)\n\n\ndef load_json(path):\n    with open(path, encoding=\"utf-8-sig\", errors=\"replace\") as f:\n        data = json.load(f)\n    if isinstance(data, dict):\n        rows = next((v for v in data.values() if isinstance(v, list)), None)\n        if rows is None:\n            raise ValueError(\"a JSON object with no array-valued key; expected rows under one\")\n    elif isinstance(data, list):\n        rows = data\n    else:\n        raise ValueError(\"expected an array of objects, or an object holding one\")\n    cols = []\n    seen = set()\n    for i, row in enumerate(rows):\n        if not isinstance(row, dict):\n            raise ValueError(f\"row {i} is not an object\")\n        for k in row:\n            if k not in seen:\n                seen.add(k)\n                cols.append(str(k))\n    cols = unique_columns(cols)\n    values = [[json_value(row.get(k)) for k in cols] for row in rows]\n    return cols, values, [\"\"] * len(cols)\n\n\ndef load_files(conn, root, spec):\n    loaded = []\n    for raw in [p.strip() for p in spec.split(\",\") if p.strip()]:\n        abs_path = contained(root, raw)\n        if abs_path is None:\n            fail(f\"{raw} is outside the working directory; files must be inside it\")\n        if not os.path.isfile(abs_path):\n            fail(f\"{raw}: no such file\")\n        ext = os.path.splitext(raw)[1].lower()\n        try:\n            if ext == \".csv\":\n                cols, rows, types = load_csv(abs_path)\n            elif ext == \".json\":\n                cols, rows, types = load_json(abs_path)\n            else:\n                fail(f\"{raw}: only .csv and .json files are supported\")\n        except (ValueError, csv.Error, UnicodeError) as e:\n            fail(f\"{raw}: {e}\")\n        if not cols:\n            fail(f\"{raw}: no columns (empty file?)\")\n        name = table_name(raw)\n        if name in {n for n, _ in loaded}:\n            fail(f\"two files would both be the table {name}; rename one\")\n        quoted = \", \".join(f'\"{c}\" {t}'.strip() for c, t in zip(cols, types))\n        conn.execute(f'CREATE TABLE \"{name}\" ({quoted})')\n        if rows:\n            marks = \", \".join(\"?\" * len(cols))\n            conn.executemany(f'INSERT INTO \"{name}\" VALUES ({marks})', rows)\n        loaded.append((name, cols))\n    return loaded\n\n\ndef strip_comments(sql):\n    sql = re.sub(r\"/\\*.*?\\*/\", \" \", sql, flags=re.S)\n    sql = re.sub(r\"--[^\\n]*\", \" \", sql)\n    return sql.strip()\n\n\ndef read_only(action, *_):\n    allowed = {\n        sqlite3.SQLITE_SELECT,\n        sqlite3.SQLITE_READ,\n        sqlite3.SQLITE_FUNCTION,\n        sqlite3.SQLITE_RECURSIVE,\n    }\n    return sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY\n\n\ndef render(fmt, cols, rows):\n    if fmt == \"json\":\n        lines = [json.dumps(dict(zip(cols, r)), ensure_ascii=False) for r in rows]\n        return \"[\\n\" + \",\\n\".join(\"  \" + l for l in lines) + \"\\n]\" if lines else \"[]\"\n    if fmt == \"csv\":\n        buf = io.StringIO()\n        w = csv.writer(buf, lineterminator=\"\\n\")\n        w.writerow(cols)\n        for r in rows:\n            w.writerow([\"\" if v is None else v for v in r])\n        return buf.getvalue().rstrip(\"\\n\")\n\n    def cell(v):\n        s = \"NULL\" if v is None else str(v).replace(\"\\n\", \" \")\n        return s if len(s) <= CELL_WIDTH else s[: CELL_WIDTH - 1] + \"\u2026\"\n\n    grid = [[cell(v) for v in r] for r in rows]\n    widths = [max([len(c)] + [len(g[i]) for g in grid]) for i, c in enumerate(cols)]\n    line = lambda cells: \" | \".join(c.ljust(w) for c, w in zip(cells, widths)).rstrip()\n    out = [line(cols), \"-+-\".join(\"-\" * w for w in widths)]\n    out += [line(g) for g in grid]\n    return \"\\n\".join(out)\n\n\ndef main():\n    p = argparse.ArgumentParser(description=\"SQL over CSV and JSON files\")\n    p.add_argument(\"--query\", required=True)\n    p.add_argument(\"--files\", default=\"\")\n    p.add_argument(\"--limit\", default=\"200\")\n    p.add_argument(\"--format\", default=\"table\", choices=[\"table\", \"csv\", \"json\"])\n    a = p.parse_args()\n\n    try:\n        limit = int(a.limit)\n    except ValueError:\n        fail(f\"limit must be a whole number, not {a.limit!r}\")\n    if limit < 1:\n        fail(\"limit must be at least 1\")\n\n    sql = strip_comments(a.query).rstrip(\";\").strip()\n    if not sql:\n        fail(\"query is empty\")\n    if not re.match(r\"(?i)^(select|with)\\b\", sql):\n        fail(\"only a single SELECT (or WITH \u2026 SELECT) runs here \u2014 the files are read-only, \"\n             \"and the database is in memory, so nothing else would persist anyway\")\n\n    root = os.path.realpath(os.getcwd())\n    conn = sqlite3.connect(\":memory:\")\n    tables = load_files(conn, root, a.files)\n    conn.execute(\"PRAGMA query_only = 1\")\n    conn.set_authorizer(read_only)\n\n    try:\n        cur = conn.execute(sql)\n    except sqlite3.Warning:\n        fail(\"one statement at a time \u2014 drop everything after the first ;\")\n    except sqlite3.Error as e:\n        schema = \"; \".join(f\"{n}({', '.join(c)})\" for n, c in tables) or \"none\"\n        fail(f\"{e}. Tables: {schema}\")\n    if cur.description is None:\n        fail(\"that statement returns no rows; only a SELECT runs here\")\n    cols = [d[0] for d in cur.description]\n    rows = cur.fetchmany(limit + 1)\n    more = len(rows) > limit\n    rows = rows[:limit]\n\n    out = render(a.format, cols, rows)\n    if len(out) > MAX_CHARS:\n        out = out[:MAX_CHARS] + f\"\\n\u2026[truncated at {MAX_CHARS} chars \u2014 lower the limit, select fewer columns, or aggregate]\"\n    print(out)\n    note = f\"({len(rows)} row{'s' if len(rows) != 1 else ''}\"\n    if more:\n        note += f\", limit {limit} reached \u2014 more rows exist; aggregate, filter, or raise limit\"\n    print(note + \")\", file=sys.stderr)\n\n\nif __name__ == \"__main__\":\n    main()\n" },
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
): { file: string; content: string }[] | null {
  const tool = GALLERY.find((t) => t.name === template && t.kind === kind);
  if (!tool) return null;
  const rename = (text: string) =>
    text
      .replace(/^name: .*$/m, `name: ${name}`)
      .replaceAll(`use: [${tool.name}]`, `use: [${name}]`);

  // A folder tool starts from a folder — a list, because a script entry is a
  // definition AND the program it runs, and handing back only the first would
  // write a `run:` pointing at a file nobody created. The folder is renamed;
  // the program's own filename is not, because `run:` names it and neither
  // travels without the other.
  if (tool.wrapper) {
    const folder = tool.file.slice(0, tool.file.indexOf("/"));
    return [
      { file: tool.file.replace(`${folder}/`, `${name}/`), content: rename(tool.content) },
      { file: tool.wrapper.file.replace(`${folder}/`, `${name}/`), content: tool.wrapper.content },
    ];
  }
  const ext = tool.file.slice(tool.file.lastIndexOf("."));
  return [{ file: `${name}${ext}`, content: rename(tool.content) }];
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
  // No path rewriting any more: a folder tool's `run:` is relative to its own
  // folder, so the same two files are correct at either scope. That rewrite
  // existing was the argument for the folder shape.
  if (workspace) {
    const rel = `${tool.kind}/${tool.file}`;
    writeWorkspaceFile(tenant, workspace, rel, tool.content);
    if (tool.wrapper) {
      writeWorkspaceFile(tenant, workspace, `tools/${tool.wrapper.file}`, tool.wrapper.content);
    }
    return rel;
  }
  writeLibraryFile(tenant, tool.kind, tool.file, tool.content);
  if (tool.wrapper) writeLibraryFile(tenant, "tools", tool.wrapper.file, tool.wrapper.content);
  return tool.file;
}
