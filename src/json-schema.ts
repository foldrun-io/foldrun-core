// A JSON Schema validator small enough to read, with no dependency.
//
// `schema:` beside `output: json` says what shape the reply's value must
// have, and a value that does not have it fails the step with a sentence
// naming the field. The subset here is the part of JSON Schema people write
// by hand for a handoff — types, required fields, enums, ranges, patterns,
// arrays, the combinators, and `$ref` to a definition in the same document.
// Formats (`date-time`, `email`) are accepted and not checked; a check that
// needs one belongs in a `verify:`. Anything the validator does not know is
// ignored, the way JSON Schema itself says unknown keywords are.
//
// Not ajv: it sits in node_modules as a dependency of a dependency, which is
// nothing to build on, and the whole of it is far more than a step needs.

export interface SchemaError {
  /** JSON pointer to the offending value: "" is the root, "/leads/0/url". */
  path: string;
  message: string;
}

type Schema = Record<string, unknown> | boolean;

const MAX_ERRORS = 8;

/** Is `value` what `schema` describes? Empty means yes. */
export function validateSchema(value: unknown, schema: unknown): SchemaError[] {
  const errors: SchemaError[] = [];
  check(value, schema as Schema, "", schema as Schema, errors, 0);
  return errors.slice(0, MAX_ERRORS);
}

/** The errors as one sentence for a trace line. */
export function describeSchemaErrors(errors: SchemaError[]): string {
  return errors.map((e) => `${e.path || "the value"}: ${e.message}`).join("; ");
}

/** Is this a schema at all? An object (or a boolean, which JSON Schema
 *  allows) — not a string, not a list. */
export function looksLikeSchema(schema: unknown): boolean {
  return typeof schema === "boolean" || (typeof schema === "object" && schema !== null && !Array.isArray(schema));
}

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;

const matchesType = (v: unknown, t: string): boolean => {
  const actual = typeOf(v);
  return t === actual || (t === "number" && actual === "integer");
};

function resolveRef(ref: string, root: Schema): Schema | null {
  if (!ref.startsWith("#")) return null;
  let node: unknown = root;
  for (const raw of ref.slice(1).split("/").filter(Boolean)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "object" && node !== null ? (node as Schema) : typeof node === "boolean" ? node : null;
}

function check(value: unknown, schema: Schema, path: string, root: Schema, errors: SchemaError[], depth: number) {
  if (errors.length >= MAX_ERRORS || depth > 64) return;
  if (schema === true) return;
  if (schema === false) return void errors.push({ path, message: "nothing is allowed here" });
  if (typeof schema !== "object" || schema === null) return;
  const s = schema as Record<string, unknown>;
  const fail = (message: string) => errors.push({ path, message });

  if (typeof s.$ref === "string") {
    const target = resolveRef(s.$ref, root);
    if (target === null) return fail(`schema: unresolvable $ref ${s.$ref}`);
    check(value, target, path, root, errors, depth + 1);
    return;
  }

  // type — one, or a list of alternatives; "nullable: true" (OpenAPI's
  // spelling) lets null through.
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [String(s.type)];
    const ok = types.some((t) => matchesType(value, t)) || (s.nullable === true && value === null);
    if (!ok) return fail(`expected ${types.join(" or ")}, got ${typeOf(value)}`);
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, value))) {
    return fail(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if ("const" in s && !deepEqual(s.const, value)) return fail(`must be ${JSON.stringify(s.const)}`);

  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) fail(`shorter than ${s.minLength} characters`);
    if (typeof s.maxLength === "number" && value.length > s.maxLength) fail(`longer than ${s.maxLength} characters`);
    if (typeof s.pattern === "string") {
      try {
        if (!new RegExp(s.pattern, "u").test(value)) fail(`does not match ${s.pattern}`);
      } catch {
        fail(`schema: invalid pattern ${s.pattern}`);
      }
    }
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) fail(`below the minimum ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) fail(`above the maximum ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) fail(`must be above ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) fail(`must be below ${s.exclusiveMaximum}`);
    if (typeof s.multipleOf === "number" && s.multipleOf > 0 && Math.abs(value / s.multipleOf - Math.round(value / s.multipleOf)) > 1e-9) {
      fail(`not a multiple of ${s.multipleOf}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) fail(`fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) fail(`more than ${s.maxItems} items`);
    if (s.uniqueItems === true) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) fail("items are not unique");
    }
    if (s.items !== undefined && !Array.isArray(s.items)) {
      value.forEach((item, i) => check(item, s.items as Schema, `${path}/${i}`, root, errors, depth + 1));
    } else if (Array.isArray(s.items) || Array.isArray(s.prefixItems)) {
      const tuple = (Array.isArray(s.prefixItems) ? s.prefixItems : s.items) as Schema[];
      tuple.forEach((sub, i) => i < value.length && check(value[i], sub, `${path}/${i}`, root, errors, depth + 1));
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (typeof s.properties === "object" && s.properties !== null ? s.properties : {}) as Record<string, Schema>;
    if (Array.isArray(s.required)) {
      for (const key of s.required as string[]) if (!(key in obj)) fail(`missing required field "${key}"`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) check(obj[key], sub, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, root, errors, depth + 1);
    }
    const patterns = (typeof s.patternProperties === "object" && s.patternProperties !== null ? s.patternProperties : {}) as Record<string, Schema>;
    for (const key of Object.keys(obj)) {
      if (key in props) continue;
      const pattern = Object.entries(patterns).find(([re]) => {
        try {
          return new RegExp(re, "u").test(key);
        } catch {
          return false;
        }
      });
      if (pattern) {
        check(obj[key], pattern[1], `${path}/${key}`, root, errors, depth + 1);
      } else if (s.additionalProperties === false) {
        fail(`unexpected field "${key}"`);
      } else if (typeof s.additionalProperties === "object" && s.additionalProperties !== null) {
        check(obj[key], s.additionalProperties as Schema, `${path}/${key}`, root, errors, depth + 1);
      }
    }
    if (typeof s.minProperties === "number" && Object.keys(obj).length < s.minProperties) fail(`fewer than ${s.minProperties} fields`);
    if (typeof s.maxProperties === "number" && Object.keys(obj).length > s.maxProperties) fail(`more than ${s.maxProperties} fields`);
  }

  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf as Schema[]) check(value, sub, path, root, errors, depth + 1);
  }
  if (Array.isArray(s.anyOf)) {
    const ok = (s.anyOf as Schema[]).some((sub) => validateSchema(value, withRoot(sub, root)).length === 0);
    if (!ok) fail("matches none of the allowed shapes (anyOf)");
  }
  if (Array.isArray(s.oneOf)) {
    const n = (s.oneOf as Schema[]).filter((sub) => validateSchema(value, withRoot(sub, root)).length === 0).length;
    if (n !== 1) fail(n === 0 ? "matches none of the allowed shapes (oneOf)" : `matches ${n} of the shapes, must match exactly one (oneOf)`);
  }
  if (s.not !== undefined && validateSchema(value, withRoot(s.not as Schema, root)).length === 0) fail("matches a shape that is not allowed (not)");
}

/** A sub-schema checked on its own still resolves `$ref` against the
 *  document it came from: carry the root's definitions along. */
function withRoot(sub: Schema, root: Schema): Schema {
  if (typeof sub !== "object" || sub === null || typeof root !== "object" || root === null) return sub;
  const defs: Record<string, unknown> = {};
  for (const key of ["$defs", "definitions"]) if (key in (root as Record<string, unknown>)) defs[key] = (root as Record<string, unknown>)[key];
  return { ...defs, ...(sub as Record<string, unknown>) };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
