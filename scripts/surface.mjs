// The public surface of @foldrun/core, read from source at any commit.
//
// release.mjs compares the surface at the last release tag with the one at
// HEAD, and the difference decides the version as much as the commit
// messages do: something a user could call that is gone, or now needs more
// arguments, is a breaking change (major) whatever the commits said;
// something new is a feature (minor). Nobody has to remember to write
// "BREAKING".
//
// What is public is package.json `foldrun.publicApi`: the entry points other
// packages may import — the root, and the subpaths the `foldrun` CLI uses.
// The `./*` export also reaches every other module in src/, because the
// runner image imports its own copy by name, but those are internal and may
// change in any release.
//
// It reads source text, not a build, so the tree at an old tag needs no
// install: `read(path)` returns a file's text at the commit, or null. The
// parser leans on the house formatting — a top-level declaration starts in
// column 0 and its body is indented — and tests/surface.test.ts holds it to
// what Node actually exports from every public module.

/** @typedef {{ what: string, kind: string, required?: number, sig?: string, min?: number, deprecated?: boolean }} Item */

/** @param {(path: string) => string | null} read @returns {Record<string, Item>} */
export function surface(read) {
  const pkg = JSON.parse(read("package.json") ?? "{}");
  /** @type {Record<string, Item>} */
  const items = {};
  const floor = nodeFloor(pkg.engines?.node);
  if (floor != null) items["engines.node"] = { what: `the Node.js it runs on (>=${floor})`, kind: "engine", min: floor };
  for (const entry of pkg.foldrun?.publicApi ?? []) {
    const spec = entry === "." ? "@foldrun/core" : `@foldrun/core/${entry.replace(/^\.\//, "")}`;
    const file = entryFile(pkg, entry);
    const text = file && read(file);
    if (text == null) continue; // an entry gone is reported by its own key going missing
    items[`entry ${entry}`] = { what: `\`${spec}\``, kind: "entry" };
    for (const [name, decl] of exportsOf(file, read, new Set())) {
      items[`${entry}#${name}`] = { what: `\`${name}\` from \`${spec}\``, ...decl };
    }
  }
  return items;
}

/** The source file an entry point resolves to. */
function entryFile(pkg, entry) {
  if (entry === ".") return "index.ts";
  const target = pkg.exports?.[entry];
  const js = typeof target === "string" ? target : target?.default;
  if (js) return js.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts");
  return `src/${entry.replace(/^\.\//, "")}.ts`;
}

function nodeFloor(range) {
  const m = String(range ?? "").match(/>=?\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Every name a module exports, following `export * from` and re-exports.
 *  @returns {Map<string, { kind: string, required?: number, sig?: string }>} */
export function exportsOf(file, read, seen) {
  const out = new Map();
  if (seen.has(file)) return out;
  seen.add(file);
  const text = read(file);
  if (text == null) return out;
  const local = declarations(text);
  for (const { text: st, deprecated } of statements(text)) {
    let m;
    if ((m = st.match(/^export\s+\*\s+from\s+["']([^"']+)["']/))) {
      for (const [k, v] of exportsOf(resolve(file, m[1]), read, seen)) if (!out.has(k)) out.set(k, v);
    } else if ((m = st.match(/^export\s+(type\s+)?\{([^}]*)\}\s*(?:from\s+["']([^"']+)["'])?/))) {
      const from = m[3] ? exportsOf(resolve(file, m[3]), read, new Set()) : local;
      for (const part of m[2].split(",").map((s) => s.trim()).filter(Boolean)) {
        const [, typeOnly, name, alias] = part.match(/^(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/) ?? [];
        if (!name) continue;
        out.set(alias ?? name, from.get(name) ?? { kind: m[1] || typeOnly ? "type" : "value" });
      }
    } else if (/^export\s/.test(st)) {
      const d = declaration(st);
      if (d) out.set(d.name, deprecated ? { ...d.decl, deprecated: true } : d.decl);
    }
  }
  return out;
}

/** Top-level declarations, exported or not, by name — for `export { x }`. */
function declarations(text) {
  const out = new Map();
  for (const { text: st, deprecated } of statements(text)) {
    const d = declaration(/^export\s/.test(st) ? st : `export ${st}`);
    if (d) out.set(d.name, deprecated ? { ...d.decl, deprecated: true } : d.decl);
  }
  return out;
}

function resolve(from, spec) {
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
  const parts = (dir + spec).split("/");
  const norm = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") norm.pop();
    else norm.push(p);
  }
  return norm.join("/").replace(/\.js$/, ".ts");
}

/** Top-level statements: a column-0 line, plus every indented, blank or
 *  closing line after it. Comment lines are dropped; a statement whose doc
 *  comment, just above it, says `@deprecated` is marked deprecated.
 *  @returns {{ text: string, deprecated: boolean }[]} */
export function statements(text) {
  const out = [];
  let cur = null;
  let inComment = false;
  let comment = ""; // the comment just above the next statement
  for (const line of text.split("\n")) {
    if (inComment) {
      comment += line;
      if (line.includes("*/")) inComment = false;
      continue;
    }
    if (/^\s*\/\*/.test(line) && !line.includes("*/")) {
      inComment = true;
      comment = line;
      continue;
    }
    if (/^\s*(\/\/|\/\*.*\*\/\s*$)/.test(line)) {
      comment = /^\s*\/\//.test(line) && /^\s*\/\//.test(comment) ? comment + line : line;
      continue;
    }
    const top = /^[^\s})\]>|&.,:?]/.test(line);
    if (top) {
      if (cur != null) out.push(cur);
      cur = { text: line, deprecated: /@deprecated\b/.test(comment) };
    } else if (cur != null) cur.text += "\n" + line;
    if (line.trim()) comment = "";
  }
  if (cur != null) out.push(cur);
  return out;
}

/** One exported declaration: its name and what a caller depends on. */
function declaration(st) {
  let m;
  if ((m = st.match(/^export\s+(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*(<)?/))) {
    const params = paramsAfter(st, m.index + m[0].length - (m[2] ? 1 : 0));
    return { name: m[1], decl: { kind: "function", required: requiredCount(params), sig: norm(params) } };
  }
  if ((m = st.match(/^export\s+(?:declare\s+)?(?:abstract\s+)?class\s+([\w$]+)/))) {
    return { name: m[1], decl: { kind: "class", sig: norm(st.split("{")[0].replace(/^export\s+/, "")) } };
  }
  if ((m = st.match(/^export\s+(?:declare\s+)?(const|let|var)\s+([\w$]+)\s*(:\s*([^=]+))?=?/))) {
    // An arrow function is called like a function, so it is held to the same rule.
    const rest = st.slice(m.index + m[0].length);
    const arrow = rest.match(/^\s*(?:async\s+)?(<[^>]*>)?\s*\(/);
    if (arrow) {
      const params = paramsAfter(rest, rest.indexOf("("));
      return { name: m[2], decl: { kind: "function", required: requiredCount(params), sig: norm(params) } };
    }
    return { name: m[2], decl: { kind: "const", ...(m[4] ? { sig: norm(m[4]) } : {}) } };
  }
  if ((m = st.match(/^export\s+(?:declare\s+)?interface\s+([\w$]+)/))) {
    return { name: m[1], decl: { kind: "interface", sig: norm(st.replace(/^export\s+/, "")) } };
  }
  if ((m = st.match(/^export\s+(?:declare\s+)?type\s+([\w$]+)/))) {
    return { name: m[1], decl: { kind: "type", sig: norm(st.replace(/^export\s+/, "")) } };
  }
  if ((m = st.match(/^export\s+(?:declare\s+)?(?:const\s+)?enum\s+([\w$]+)/))) {
    return { name: m[1], decl: { kind: "enum", sig: norm(st.replace(/^export\s+/, "")) } };
  }
  return null;
}

/** The parameter list text after `at` (skipping type parameters), without
 *  its parentheses. String-aware, bracket-aware. */
function paramsAfter(s, at) {
  let i = at;
  if (s[i] === "<") i = matching(s, i);
  while (i < s.length && s[i] !== "(") i++;
  const end = matching(s, i);
  return s.slice(i + 1, end - 1);
}

/** The index just past the bracket that closes the one at `i`. */
function matching(s, i) {
  const open = s[i];
  const close = { "(": ")", "[": "]", "{": "}", "<": ">" }[open];
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'" || c === "`") {
      j = skipString(s, j);
      continue;
    }
    if (c === "=" && s[j + 1] === ">") {
      j++; // the arrow in a function type, not a closing angle
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return s.length;
}

function skipString(s, i) {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === q) return j;
  }
  return s.length;
}

/** Split a parameter list on its top-level commas. */
function splitParams(list) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (let j = 0; j < list.length; j++) {
    const c = list[j];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(list, j);
      cur += list.slice(j, end + 1);
      j = end;
      continue;
    }
    if (c === "=" && list[j + 1] === ">") {
      cur += "=>";
      j++;
      continue;
    }
    if ("([{<".includes(c)) depth++;
    if (")]}>".includes(c)) depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** How many arguments a caller must pass: parameters before the first one
 *  that is optional, has a default, or is a rest parameter. */
export function requiredCount(list) {
  let n = 0;
  for (const p of splitParams(list)) {
    if (p.startsWith("...")) break;
    const head = p.replace(/^(public|private|protected|readonly)\s+/, "");
    // `name?: T`, or a default after the name or a destructuring pattern
    const name = head.startsWith("{") || head.startsWith("[") ? head.slice(0, matching(head, 0)) : (head.match(/^[\w$]+\??/) ?? [""])[0];
    const after = head.slice(name.length).trimStart();
    if (name.endsWith("?")) break;
    if (/^(?::[\s\S]*?)?=(?!>)/.test(topLevelEquals(after))) break;
    n++;
  }
  return n;
}

/** The text with nested brackets blanked, so `=` in a type is not a default. */
function topLevelEquals(s) {
  let depth = 0;
  let out = "";
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "=" && s[j + 1] === ">") {
      out += depth ? "  " : "=>";
      j++;
      continue;
    }
    if ("([{<".includes(c)) depth++;
    if (")]}>".includes(c)) depth--;
    out += depth ? " " : c;
  }
  return out;
}

function norm(s) {
  return s.replace(/\s+/g, " ").replace(/,\s*([)}\]>])/g, "$1").trim();
}
