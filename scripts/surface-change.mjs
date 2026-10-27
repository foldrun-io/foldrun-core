// Is a changed public declaration only WIDER — something that cannot break
// a consumer — or does it need a major? (27 Oct 2026: releases merge
// themselves now, so "a person checks the changed list before merging" is
// gone; release.mjs used to list changed declarations and leave the version
// to that person.)
//
// The rules follow Semantic Versioning for TypeScript Types
// (https://www.semver-ts.org/formal-spec/2-breaking-changes.html and
// …/3-non-breaking-changes.html), resolved conservatively where the answer
// depends on how a consumer uses the type — this package cannot know:
//
//   - an interface or object type that only GAINS OPTIONAL members, every
//     existing member unchanged, is additive (an object built before still
//     satisfies it; a reader is never handed less);
//   - a function that only gains OPTIONAL trailing parameters, the existing
//     ones unchanged, is additive;
//   - everything else is a break: a member removed (even an optional one) or
//     retyped, a required member added, a union widened (a wider output can
//     break an exhaustive switch), a class or enum changed, a kind changed.
//
// Shipping a major that could have been a minor costs a version number; the
// reverse breaks someone's build under a version that promised it would not.
//
// Pure: it reads the normalised `sig` strings surface.mjs records.

/** { additive: true } or { additive: false, why } for a declaration whose
 *  kind or signature differs between two surfaces. */
export function changeOf(before, after) {
  if (before.kind !== after.kind) return { additive: false, why: `was a ${before.kind}, now a ${after.kind}` };
  const b = before.sig ?? "";
  const a = after.sig ?? "";
  if (b === a) return { additive: true };
  if (before.kind === "interface") return objectChange(b, a);
  if (before.kind === "type" && braced(b) && braced(a)) return objectChange(b, a);
  if (before.kind === "function") return paramsChange(b, a);
  return { additive: false, why: "its declaration changed" };
}

// The whole right-hand side is one object literal — not a union or an
// intersection that happens to end in one (Codex review).
const braced = (sig) => {
  const eq = sig.indexOf("=");
  return eq >= 0 && wholeObject(sig.slice(eq + 1).trim().replace(/;$/, "").trim());
};

/** The bracket depth of every character of `text`, or null for one inside
 *  a string or template literal — the one scanner every check here uses, so
 *  quotes, escapes (`"\\"`) and `=>` are read the same way everywhere
 *  (Codex review). An opening bracket has the depth outside it; a closing
 *  one too. */
function depths(text) {
  const out = new Array(text.length).fill(null);
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++; // the escaped character, whatever it is
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if ("([{<".includes(ch)) {
      out[i] = depth;
      depth++;
    } else if (")]}".includes(ch) || (ch === ">" && text[i - 1] !== "=")) {
      depth--;
      out[i] = depth;
    } else out[i] = depth;
  }
  return out;
}

/** Do the brackets of `text` close, outside strings? A `<` that is a
 *  comparison (`b = 2 < 3`) leaves them open: whatever it means, it cannot be
 *  read reliably, and unreadable is a break (Codex review). */
function balanced(text) {
  let depth = 0;
  const d = depths(text);
  for (let i = 0; i < text.length; i++) {
    if (d[i] === null) continue;
    const ch = text[i];
    if ("([{<".includes(ch)) depth++;
    else if (")]}".includes(ch) || (ch === ">" && text[i - 1] !== "=")) depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/** Split `text` at `sep` where it is not inside (), [], {}, <> or a string. */
function topLevel(text, sep) {
  const d = depths(text);
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === sep && d[i] === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** The text before the outer `{`, and the members inside it, by name. */
function members(sig) {
  const open = sig.indexOf("{");
  const close = sig.lastIndexOf("}");
  if (open < 0 || close < open || !balanced(sig)) return null;
  const map = new Map();
  // Members end in `;` or `,` — both are valid in an object type (Codex
  // review: `b?: string, c: number` read as one optional member).
  const body = sig.slice(open + 1, close);
  for (const m of topLevel(body, ";").flatMap((part) => topLevel(part, ","))) {
    const name = /^(?:readonly\s+)?([A-Za-z_$][\w$]*|"[^"]*"|'[^']*'|\[[^\]]*\])(\?)?/.exec(m);
    if (!name) return null;
    // Members on separate lines need no `;`, and surface.mjs flattens the
    // lines: what reads as one member may be two (Codex review). Unsure is
    // unparsable, and unparsable is a break.
    if (secondMember(m.slice(name[0].length))) return null;
    // A method may be overloaded: one name, several signatures.
    const key = name[1];
    const prev = map.get(key);
    map.set(key, { optional: name[2] === "?", text: prev ? `${prev.text};${m}` : m });
  }
  return { head: sig.slice(0, open).trim(), map };
}

/** After a member's name: does another `name:` / `name?:` / `name(` start
 *  at the top level of what should be its one type? */
function secondMember(rest) {
  const d = depths(rest);
  const colon = rest.indexOf(":");
  if (colon < 0) return false;
  // Words that continue one type rather than start a member.
  const joins = /^(?:extends|is|keyof|typeof|readonly|infer|unique|asserts|in|as|satisfies)\b/;
  for (let i = colon + 1; i < rest.length; i++) {
    if (d[i] !== 0 || !/\s/.test(rest[i])) continue;
    // What came before the space: the end of a type (a name, a closing
    // bracket, a quote) — not an operator that expects more of it.
    const before = rest.slice(0, i).trimEnd();
    const last = before[before.length - 1] ?? "";
    if (!/[\w$)\]}>"'`]/.test(last) || before.endsWith("=>")) continue;
    // …nor a word like `extends` or `keyof`, which a type follows.
    if (/(?:^|[^\w$])(?:extends|is|keyof|typeof|readonly|infer|unique|asserts|in|as|satisfies|new)$/.test(before)) continue;
    const next = rest.slice(i).trimStart();
    // `[key]:` is a computed member; any other `[` continues the type.
    if (/^\[[^\]]*\]\??\s*[:(]/.test(next)) return true;
    if (!next || /^[|&?:=,;.)\]}>[]/.test(next) || joins.test(next)) continue;
    // A name, a quoted or computed name, a call or construct signature, a
    // generic method: another member, flattened onto this one's line.
    return true;
  }
  return false;
}

function objectChange(b, a) {
  const before = members(b);
  const after = members(a);
  if (!before || !after) return { additive: false, why: "its shape changed" };
  if (before.head !== after.head) return { additive: false, why: "its declaration line changed" };
  for (const [name, m] of before.map) {
    const now = after.map.get(name);
    if (!now) return { additive: false, why: `${name} is gone` };
    if (now.text !== m.text && !memberWidened(m, now)) return { additive: false, why: `${name} changed` };
  }
  for (const [name, m] of after.map) {
    if (!before.map.has(name) && !m.optional) return { additive: false, why: `${name} is new and required` };
  }
  return { additive: true };
}

/** A property whose type is the same union of the same parts, each object
 *  part of it only gaining optional members — `reserved?: { cpus: number }
 *  | null` becoming `{ cpus: number; diskGiB?: number } | null`. Its
 *  optionality and every other part must be untouched. A method's text must
 *  match exactly. */
function memberWidened(before, after) {
  if (before.optional !== after.optional) return false;
  const typeOf = (text) => {
    const parts = topLevel(text, ":");
    return parts.length < 2 || /^[^:]*\(/.test(parts[0]) ? null : { key: parts[0], type: text.slice(parts[0].length + 1).trim() };
  };
  const b = typeOf(before.text);
  const a = typeOf(after.text);
  if (!b || !a || b.key !== a.key) return false;
  const bParts = topLevel(b.type, "|");
  const aParts = topLevel(a.type, "|");
  if (bParts.length !== aParts.length) return false;
  return bParts.every((p, i) => {
    const q = aParts[i];
    if (p === q) return true;
    // Only a whole object literal, nothing after its closing brace: `{…}[]`
    // or `{…} & X` is another type (Codex review — `{ id }` → `{ id }[]`
    // passed as additive).
    if (!wholeObject(p) || !wholeObject(q)) return false;
    return objectChange(p, q).additive;
  });
}

/** `text` is one object literal `{ … }` and nothing else. */
function wholeObject(text) {
  if (!text.startsWith("{")) return false;
  const d = depths(text);
  for (let i = 1; i < text.length; i++) if (text[i] === "}" && d[i] === 0) return i === text.length - 1;
  return false;
}

// surface.mjs records a function's parameters without their outer
// parentheses (paramsAfter): split them as they are — stripping a `)` would
// cut a default like `o = make()` (Codex review).
/** A rest parameter that may take no arguments: untyped, `T[]` or
 *  `Array<T>`. A tuple (`...rest: [number]`) may require some — treated as
 *  required (Codex review). */
function optionalRest(p) {
  const m = /^\.\.\.[A-Za-z_$][\w$]*\s*(?::\s*([\s\S]*))?$/.exec(p);
  if (!m) return false;
  const type = (m[1] ?? "").trim();
  // One array type, nothing joined to it: `{ 0: number } & number[]` needs an
  // argument whatever its suffix (Codex review).
  if (topLevel(type, "&").length > 1 || topLevel(type, "|").length > 1) return false;
  return type === "" || (/\[\]$/.test(type) && !type.startsWith("[")) || /^(readonly\s+)?Array<[\s\S]*>$/.test(type) || /^ReadonlyArray<[\s\S]*>$/.test(type);
}

/** A parameter with a default: a top-level `=` that is not part of `=>`,
 *  `==`, `<=` or `>=` (Codex review — `cb: () => void` read as defaulted). */
function hasDefault(p) {
  const d = depths(p);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "=" && d[i] === 0 && p[i + 1] !== ">" && p[i + 1] !== "=" && !"=!<>".includes(p[i - 1] ?? "")) return true;
  }
  return false;
}

function paramsChange(b, a) {
  if (!balanced(b) || !balanced(a)) return { additive: false, why: "its parameters could not be read" };
  const before = topLevel(b, ",");
  const after = topLevel(a, ",");
  if (after.length < before.length) return { additive: false, why: "it takes fewer parameters" };
  for (let i = 0; i < before.length; i++) {
    if (after[i] !== before[i]) return { additive: false, why: `parameter ${i + 1} changed` };
  }
  for (const p of after.slice(before.length)) {
    // Optional (`x?:`), defaulted (`x = 1`) or a rest parameter (`...xs`).
    if (!/^[A-Za-z_$][\w$]*\?\s*:/.test(p) && !optionalRest(p) && !hasDefault(p)) return { additive: false, why: "it takes a new required parameter" };
  }
  return { additive: true };
}
