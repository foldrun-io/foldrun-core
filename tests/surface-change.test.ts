// Whether a changed public declaration only widened (a minor) or must be a
// major (scripts/surface-change.mjs) — the rule that replaced a person
// reading the changed list before a release merged (27 Oct 2026).
//
//   node --test tests/surface-change.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
// @ts-expect-error a plain .mjs script, no declarations
import { changeOf } from "../scripts/surface-change.mjs";
// @ts-expect-error a plain .mjs script, no declarations
import { surface, statements } from "../scripts/surface.mjs";

const iface = (body: string) => ({ kind: "interface", sig: `interface X { ${body} }` });
const fn = (params: string) => ({ kind: "function", sig: params }); // as surface.mjs records them: no outer ( )

test("an interface that only gains optional members widened; a required one, a removal or a retype is a break", () => {
  assert.deepEqual(changeOf(iface("a: string;"), iface("a: string; b?: number;")), { additive: true });
  assert.deepEqual(changeOf(iface("a: string;"), iface("a: string; m?(x: { y?: number }): void;")), { additive: true }, "an optional method, braces inside");
  assert.match(changeOf(iface("a: string;"), iface("a: string; b: number;")).why, /b is new and required/);
  assert.match(changeOf(iface("a: string; b?: number;"), iface("a: string;")).why, /b is gone/, "even an optional one");
  assert.match(changeOf(iface("a: string;"), iface("a: string | number;")).why, /a changed/);
  assert.match(changeOf(iface("a?: string;"), iface("a: string;")).why, /a changed/, "optional made required");
  assert.match(changeOf({ kind: "interface", sig: "interface X { a: string }" }, { kind: "interface", sig: "interface X extends Y { a: string }" }).why, /declaration line/);
});

test("a function that only gains optional trailing parameters widened; anything else is a break", () => {
  assert.deepEqual(changeOf(fn("a: string"), fn("a: string, b?: number")), { additive: true });
  assert.deepEqual(changeOf(fn("a: string"), fn("a: string, b = 1")), { additive: true });
  assert.deepEqual(changeOf(fn("a: string"), fn("a: string, ...rest: string[]")), { additive: true });
  assert.deepEqual(changeOf(fn("a: string, o: { x?: number }"), fn("a: string, o: { x?: number }, more?: boolean")), { additive: true }, "commas inside a type are not parameters");
  assert.match(changeOf(fn("a: string"), fn("a: string, b: number")).why, /new required parameter/);
  assert.match(changeOf(fn("a: string"), fn("a: string | number")).why, /parameter 1 changed/);
});

test("a widened union, a changed class or a changed kind is a break — the conservative reading", () => {
  assert.equal(changeOf({ kind: "type", sig: 'type L = "a" | "b";' }, { kind: "type", sig: 'type L = "a" | "b" | "c";' }).additive, false);
  assert.equal(changeOf({ kind: "class", sig: "class A" }, { kind: "class", sig: "class A extends B" }).additive, false);
  assert.match(changeOf({ kind: "type" }, { kind: "interface" }).why, /was a type, now a interface/);
  assert.deepEqual(changeOf({ kind: "type", sig: "type O = { a: string };" }, { kind: "type", sig: "type O = { a: string; b?: number };" }), { additive: true }, "an object type alias reads like an interface");
});

// The real thing: 2.13.1 → 2.14.0 added optional fields to four exported
// types (checked by hand on 27 Oct 2026). The rule must call it a minor.
test("the real 2.13.1 → 2.14.0 changes are all additive", () => {
  const root = path.join(import.meta.dirname, "..");
  const at = (ref: string) => (p: string) => {
    try {
      return execFileSync("git", ["show", `${ref}:${p}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
  try {
    execFileSync("git", ["rev-parse", "v2.13.1", "v2.14.0"], { cwd: root, stdio: "ignore" });
  } catch {
    return; // a shallow clone without the tags: nothing to compare
  }
  const before = surface(at("v2.13.1")) as Record<string, { kind: string; sig?: string }>;
  const after = surface(at("v2.14.0")) as Record<string, { kind: string; sig?: string }>;
  const changed = Object.keys(before).filter((k) => after[k] && (before[k].kind !== after[k].kind || (before[k].sig ?? "") !== (after[k].sig ?? "")));
  assert.ok(changed.length >= 4, `expected the four widened types, got ${changed.join(", ")}`);
  for (const k of changed) assert.deepEqual(changeOf(before[k], after[k]), { additive: true }, k);
});

test("an object inside a property's type that only gains optional members widened; any other change in it is a break", () => {
  const r = (t: string) => iface(`reserved?: ${t};`);
  assert.deepEqual(changeOf(r("{ cpus: number } | null"), r("{ cpus: number; diskGiB?: number } | null")), { additive: true });
  assert.match(changeOf(r("{ cpus: number } | null"), r("{ cpus: number; diskGiB: number } | null")).why, /reserved changed/);
  assert.match(changeOf(r("{ cpus: number } | null"), r("{ cpus: string } | null")).why, /reserved changed/);
  assert.match(changeOf(r("{ cpus: number } | null"), r("{ cpus: number } | null | undefined")).why, /reserved changed/, "a union widened");
});

// Codex review, round 2.
test("an object made an array, or joined with another type, is a break; a default that calls something survives", () => {
  const v = (t: string) => iface(`value: ${t};`);
  assert.match(changeOf(v("{ id: string }"), v("{ id: string }[]")).why, /value changed/);
  assert.match(changeOf(v("{ id: string }"), v("{ id: string } & Extra")).why, /value changed/);
  assert.deepEqual(changeOf(fn("o = makeOptions()"), fn("o = makeOptions(), extra?: boolean")), { additive: true });
  assert.deepEqual(changeOf(fn("f: (x: number) => void"), fn("f: (x: number) => void, g?: () => void")), { additive: true }, "arrows inside parameter types");
});

// Codex review, round 3.
test("a required callback after a defaulted parameter is a break; comma-separated members are each read", () => {
  assert.match(changeOf(fn("a = 1"), fn("a = 1, cb: () => void")).why, /new required parameter/);
  assert.deepEqual(changeOf(fn("a = 1"), fn("a = 1, cb = () => {}")), { additive: true }, "a defaulted callback is still optional");
  const t = (body: string) => ({ kind: "type", sig: `type X = { ${body} };` });
  assert.match(changeOf(t("a: string"), t("a: string; b?: string, c: number")).why, /c is new and required/);
  assert.deepEqual(changeOf(t("a: string"), t("a: string, b?: Map<string, number>")), { additive: true }, "a comma inside a generic is not a separator");
});

// Codex review, round 4.
test("an alias that becomes a union of objects is a break; a tuple rest parameter is required", () => {
  assert.equal(changeOf({ kind: "type", sig: "type X = { a: string };" }, { kind: "type", sig: "type X = { a: string; b?: number } | { c: boolean };" }).additive, false);
  assert.match(changeOf(fn("a: string"), fn("a: string, ...rest: [number]")).why, /new required parameter/);
  assert.deepEqual(changeOf(fn("a: string"), fn("a: string, ...rest: number[]")), { additive: true });
  assert.deepEqual(changeOf(fn("a: string"), fn("a: string, ...rest: Array<number>")), { additive: true });
});

// Codex review, round 5.
test("members on separate lines are not read as one; a // inside a string is not a comment", () => {
  assert.equal(changeOf({ kind: "interface", sig: "interface R { id: string }" }, { kind: "interface", sig: "interface R { id: string note?: string owner: string }" }).additive, false, "flattened members: unsure, so a break");
  assert.deepEqual(changeOf(iface("cb: (x: number) => void;"), iface("cb: (x: number) => void; n?: number;")), { additive: true }, "a parameter name inside a type is not a member");
  const [st] = statements('export type Label = "prefix // old"; // a note\n') as { text: string }[];
  assert.match(st.text, /"prefix \/\/ old";/, "the literal is kept whole");
  assert.doesNotMatch(st.text, /a note/, "the trailing comment is not");
});

test("a quoted or computed member flattened onto the line before is caught too", () => {
  const before = { kind: "interface", sig: "interface X { id: string; }" };
  assert.equal(changeOf(before, { kind: "interface", sig: 'interface X { id: string; note?: string "owner": string }' }).additive, false);
  assert.equal(changeOf(before, { kind: "interface", sig: "interface X { id: string; note?: string [key]: string }" }).additive, false);
});

test("an escaped backslash at the end of a string literal does not swallow the next member", () => {
  const before = { kind: "interface", sig: "interface X { id: string; }" };
  assert.match(changeOf(before, { kind: "interface", sig: 'interface X { id: string; path?: "\\\\"; owner: string; }' }).why, /owner is new and required/);
  assert.deepEqual(changeOf(before, { kind: "interface", sig: 'interface X { id: string; path?: "\\\\"; }' }), { additive: true });
});

test("a // inside a multi-line template literal type is part of the type", () => {
  const [st] = statements("export type Label = `hello\n  world // old\n  `; // a note\n") as { text: string }[];
  assert.match(st.text, /world \/\/ old/);
  assert.doesNotMatch(st.text, /a note/);
});

test("a comparison inside a default cannot hide a required parameter: unreadable is a break", () => {
  assert.equal(changeOf(fn("a = 1"), fn("a = 1, b = 2 < 3, c: string")).additive, false);
  assert.deepEqual(changeOf(fn("a: Map<string, number>"), fn("a: Map<string, number>, b?: Array<string>")), { additive: true }, "generics still read");
});

test("a generic method flattened after an optional member is caught", () => {
  assert.equal(changeOf({ kind: "interface", sig: "interface X { id: string; }" }, { kind: "interface", sig: "interface X { id: string; note?: string owner<T>(x: T): T }" }).additive, false);
});

test("a > comparison inside a default cannot hide a required parameter either", () => {
  assert.equal(changeOf(fn("a = 1"), fn("a = 1, b = 3 > 2, c: string")).additive, false);
});

test("any member flattened after a type is caught — a call signature too — and a one-line type is not", () => {
  const before = { kind: "interface", sig: "interface X { id: string; }" };
  assert.equal(changeOf(before, { kind: "interface", sig: "interface X { id: string; note?: string[] (): void }" }).additive, false);
  assert.equal(changeOf(before, { kind: "interface", sig: "interface X { id: string; note?: string new (): X }" }).additive, false);
  for (const t of ["string | (() => void)", "T extends string ? A : B", "Map<string, number>", "keyof Y", "readonly string[]", "{ a: string } & { b?: number }", '"a" | "b"']) {
    assert.deepEqual(changeOf(before, { kind: "interface", sig: `interface X { id: string; n?: ${t}; }` }), { additive: true }, t);
  }
  assert.deepEqual(changeOf(before, { kind: "interface", sig: "interface X { id: string; isA?(x: unknown): x is string; }" }), { additive: true }, "a type predicate");
});

test("a rest parameter joined with another type is required", () => {
  assert.equal(changeOf(fn("a: string"), fn("a: string, ...rest: { 0: number } & number[]")).additive, false);
  assert.deepEqual(changeOf(fn("a: string"), fn("a: string, ...rest: (string | number)[]")), { additive: true }, "a parenthesised union inside the array is fine");
});
