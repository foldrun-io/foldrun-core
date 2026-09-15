// The validator behind `schema:` — the hand-written subset of JSON Schema,
// with a sentence per failure that names the field.
//
//   node --test tests/json-schema.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSchema, describeSchemaErrors, looksLikeSchema } from "../src/json-schema.ts";

const lead = {
  type: "object",
  required: ["name", "url"],
  properties: {
    name: { type: "string", minLength: 1 },
    url: { type: "string", pattern: "^https://" },
    score: { type: "integer", minimum: 0, maximum: 100 },
    tags: { type: "array", items: { type: "string" }, maxItems: 3, uniqueItems: true },
    kind: { enum: ["firm", "sole"] },
  },
  additionalProperties: false,
};

test("a fitting value has no errors; each miss names its field", () => {
  assert.deepEqual(validateSchema({ name: "Acme", url: "https://a", score: 7, tags: ["x"], kind: "firm" }, lead), []);
  const errors = validateSchema({ name: "", url: "http://a", score: 101.5, tags: ["x", "x"], kind: "shop", extra: 1 }, lead);
  const text = describeSchemaErrors(errors);
  assert.match(text, /\/name: shorter than 1 characters/);
  assert.match(text, /\/url: does not match \^https:\/\//);
  assert.match(text, /\/score: expected integer, got number/);
  assert.match(text, /\/tags: items are not unique/);
  assert.match(text, /\/kind: must be one of "firm", "sole"/);
  assert.match(text, /unexpected field "extra"/);
  assert.match(describeSchemaErrors(validateSchema({ name: "a" }, lead)), /the value: missing required field "url"/);
});

test("arrays of objects: the path says which item", () => {
  const list = { type: "array", items: lead, minItems: 1 };
  assert.deepEqual(validateSchema([{ name: "a", url: "https://a" }], list), []);
  assert.match(describeSchemaErrors(validateSchema([{ name: "a", url: "https://a" }, { name: "b" }], list)), /^\/1: missing required field "url"/);
  assert.match(describeSchemaErrors(validateSchema([], list)), /fewer than 1 items/);
  assert.match(describeSchemaErrors(validateSchema("nope", list)), /expected array, got string/);
});

test("types as a list, nullable, const, numbers", () => {
  const s = { type: ["string", "null"] };
  assert.deepEqual(validateSchema(null, s), []);
  assert.deepEqual(validateSchema("x", s), []);
  assert.match(describeSchemaErrors(validateSchema(1, s)), /expected string or null, got integer/);
  assert.deepEqual(validateSchema(null, { type: "string", nullable: true }), []);
  assert.match(describeSchemaErrors(validateSchema("b", { const: "a" })), /must be "a"/);
  assert.match(describeSchemaErrors(validateSchema(5, { type: "number", exclusiveMaximum: 5 })), /must be below 5/);
  assert.match(describeSchemaErrors(validateSchema(7, { multipleOf: 2 })), /not a multiple of 2/);
  assert.deepEqual(validateSchema(3, { type: "number" }), [], "an integer is a number");
});

test("the combinators and a local $ref", () => {
  const doc = {
    $defs: { money: { type: "number", minimum: 0 } },
    type: "object",
    properties: {
      price: { $ref: "#/$defs/money" },
      either: { anyOf: [{ type: "string" }, { type: "integer" }] },
      exactly: { oneOf: [{ type: "string" }, { type: "string", minLength: 3 }] },
      both: { allOf: [{ type: "string" }, { maxLength: 2 }] },
      never: { not: { type: "string" } },
    },
  };
  assert.deepEqual(validateSchema({ price: 1, either: 2, exactly: "ab", both: "ab", never: 1 }, doc), []);
  const text = describeSchemaErrors(validateSchema({ price: -1, either: true, exactly: "abcd", both: "abc", never: "s" }, doc));
  assert.match(text, /\/price: below the minimum 0/);
  assert.match(text, /\/either: matches none of the allowed shapes \(anyOf\)/);
  assert.match(text, /\/exactly: matches 2 of the shapes/);
  assert.match(text, /\/both: longer than 2 characters/);
  assert.match(text, /\/never: matches a shape that is not allowed/);
  assert.match(describeSchemaErrors(validateSchema(1, { $ref: "#/$defs/missing" })), /unresolvable \$ref/);
});

test("what counts as a schema, and what a schema ignores", () => {
  assert.ok(looksLikeSchema({ type: "object" }));
  assert.ok(looksLikeSchema(true));
  assert.ok(!looksLikeSchema("type: object"));
  assert.ok(!looksLikeSchema([{ type: "object" }]));
  assert.deepEqual(validateSchema({ a: 1 }, { type: "object", format: "whatever", "x-vendor": 1 }), [], "unknown keywords and formats are ignored");
  assert.deepEqual(validateSchema("anything", true), []);
  assert.match(describeSchemaErrors(validateSchema("anything", false)), /nothing is allowed/);
  // Errors are bounded: a thousand bad items is eight lines, not a thousand.
  const many = validateSchema(Array.from({ length: 1000 }, () => 1), { type: "array", items: { type: "string" } });
  assert.equal(many.length, 8);
});
