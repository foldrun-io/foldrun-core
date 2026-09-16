import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLanguage, languageProblem, resolveLanguage, languageName } from "../src/language.ts";

test("a language tag is normalised, and anything else is not one", () => {
  assert.equal(normalizeLanguage("en"), "en");
  assert.equal(normalizeLanguage("en-AU"), "en-AU");
  assert.equal(normalizeLanguage(" en_au "), "en-AU");
  assert.equal(normalizeLanguage("FA-ir"), "fa-IR");
  assert.equal(normalizeLanguage("english"), null, "a word, not a tag");
  assert.equal(normalizeLanguage("en-AUS"), null);
  assert.equal(normalizeLanguage(42), null);
});

test("unset inherits; a bad value is a sentence for check", () => {
  assert.equal(languageProblem(undefined), null);
  assert.equal(languageProblem(""), null);
  assert.equal(languageProblem("fa"), null);
  assert.match(languageProblem("Persian")!, /not a language tag/);
});

test("the cascade: nearest readable level wins, a bad level is skipped with a line, env then English", () => {
  const got = resolveLanguage([
    { level: "agent", value: undefined },
    { level: "workspace", value: "Persian" },
    { level: "account", value: "fa-IR" },
  ], {});
  assert.equal(got.language, "fa-IR");
  assert.equal(got.from, "account");
  assert.equal(got.lines.length, 1);
  assert.match(got.lines[0], /workspace says "Persian"/);

  assert.deepEqual(resolveLanguage([], { FOLDRUN_LANGUAGE: "de" }), { language: "de", from: "env", lines: [] });
  assert.deepEqual(resolveLanguage([], {}), { language: "en", from: "default", lines: [] });
  assert.equal(resolveLanguage([{ level: "agent", value: "pt_BR" }], {}).language, "pt-BR");
});

test("a tag has a name a prompt can use", () => {
  assert.equal(languageName("fa-IR"), "Persian (Iran)");
  assert.equal(languageName("en"), "English");
});
