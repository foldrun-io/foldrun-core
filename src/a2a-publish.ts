// A flow's `a2a:` block — whether outside agents may call it over the
// Agent2Agent protocol (A2A 1.0), and what its agent card says (1 Nov 2026).
//
//   a2a:
//     publish: true
//     name: Lead researcher           # the card's name; else the flow's
//     description: Finds three leads  # the card's description; else the flow's
//     examples: ["Leads for dentists in Perth"]
//     public_card: false              # true: the card is readable without a key
//     input: { type: object, required: [city], properties: { city: { type: string } } }
//     accept_risk: [researcher]       # agents an admin accepted holding a secret while running code
//
// Publishing is the owner's decision, so it is written in the flow and nowhere
// else, and changing it needs workspace:manage (foldrun-web
// server/workspace-policy.ts). A caller still needs an A2A key that names the
// flow: a published flow is callable, never open.
//
// Pure: no fs, no store, so the browser (the editor) and check read the same
// function. A block with any problem publishes nothing — a typo must not open
// a flow nobody meant to open, nor a card say something nobody wrote.

import { looksLikeSchema } from "./json-schema.ts";

export interface A2aPublication {
  publish: boolean;
  /** The card's name; null = the flow's name. */
  name: string | null;
  /** The card's (and the skill's) description; null = the flow's. */
  description: string | null;
  examples: string[];
  /** The card can be read without a key. Calling it never can. */
  publicCard: boolean;
  /** A JSON Schema the request's data part must satisfy; null = any (or none). */
  input: Record<string, unknown> | boolean | null;
  /** The agents of this flow an admin accepted holding a secret while they
   *  can run code (FOL-112): their answer goes back to the caller, so the
   *  platform refuses to publish such a flow unless each is named here.
   *  Absent when the block does not say `accept_risk:`. */
  acceptRisk?: string[];
}

/** The bounds on what is published, and on what a caller may send. */
export const A2A_LIMITS = {
  name: 100,
  description: 2_000,
  examples: 10,
  exampleLength: 500,
  /** The input schema, as JSON. */
  inputSchemaBytes: 16_000,
  /** One request: how many parts, how much text, how much JSON. */
  parts: 16,
  textChars: 32_000,
  dataBytes: 64_000,
  /** What a task's answer carries back. */
  resultChars: 64_000,
  resultDataBytes: 256_000,
  /** Agents named under accept_risk. */
  acceptRisk: 50,
} as const;

/** One agent name: one path segment, as an agent's folder is. */
const ONE_NAME = /^[^/\\\0\s]+$/;

const KEYS = ["publish", "name", "description", "examples", "public_card", "input", "accept_risk"] as const;

/** What is wrong with an `a2a:` value, each as a sentence. Empty: fine (or absent). */
export function a2aPublishProblems(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v !== "object" || Array.isArray(v)) return ["should be a map — `a2a: { publish: true }`; as written the flow is not published"];
  const o = v as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(o)) {
    if (!(KEYS as readonly string[]).includes(k)) out.push(`\`${k}\` is not one of ${KEYS.join(", ")}`);
  }
  if (typeof o.publish !== "boolean") out.push("`publish` is required, true or false");
  const text = (k: "name" | "description", max: number) => {
    const t = o[k];
    if (t === undefined || t === null) return;
    if (typeof t !== "string" || !t.trim()) out.push(`\`${k}\` should be text`);
    else if (t.length > max) out.push(`\`${k}\` is longer than ${max} characters`);
  };
  text("name", A2A_LIMITS.name);
  text("description", A2A_LIMITS.description);
  if (o.examples !== undefined && o.examples !== null) {
    if (!Array.isArray(o.examples) || o.examples.some((e) => typeof e !== "string" || !e.trim())) out.push("`examples` should be a list of example requests, as text");
    else if (o.examples.length > A2A_LIMITS.examples) out.push(`\`examples\` holds more than ${A2A_LIMITS.examples}`);
    else if (o.examples.some((e) => (e as string).length > A2A_LIMITS.exampleLength)) out.push(`an example is longer than ${A2A_LIMITS.exampleLength} characters`);
  }
  if (o.public_card !== undefined && o.public_card !== null && typeof o.public_card !== "boolean") out.push("`public_card` should be true or false");
  if (o.input !== undefined && o.input !== null) {
    if (!looksLikeSchema(o.input)) out.push("`input` should be a JSON Schema — a map (type, properties, required, …)");
    else {
      let size = Infinity;
      try {
        size = JSON.stringify(o.input).length;
      } catch {
        // a value JSON cannot write is not a schema
      }
      if (size > A2A_LIMITS.inputSchemaBytes) out.push(`\`input\` is larger than ${A2A_LIMITS.inputSchemaBytes} bytes as JSON`);
    }
  }
  if (o.accept_risk !== undefined && o.accept_risk !== null) {
    const v = o.accept_risk;
    if (!Array.isArray(v) || v.some((e) => typeof e !== "string" || !ONE_NAME.test(e.trim()))) out.push("`accept_risk` should be a list of agent names — the agents an admin accepted holding a secret while they can run code");
    else if (v.length > A2A_LIMITS.acceptRisk) out.push(`\`accept_risk\` names more than ${A2A_LIMITS.acceptRisk} agents`);
  }
  return out;
}

/** One sentence for `foldrun check` (frontmatter-schema.ts), or null. */
export function a2aPublishProblem(v: unknown): string | null {
  const p = a2aPublishProblems(v);
  return p.length ? `${p.join("; ")} — until it reads, the flow is not published` : null;
}

/** The block as the platform serves it: null when absent or when it has any
 *  problem (fail closed — nothing is published by a block that does not read). */
export function parseA2aPublish(v: unknown): A2aPublication | null {
  if (v === undefined || v === null) return null;
  if (a2aPublishProblems(v).length) return null;
  const o = v as Record<string, unknown>;
  const trimmed = (t: unknown) => (typeof t === "string" && t.trim() ? t.trim() : null);
  return {
    publish: o.publish === true,
    name: trimmed(o.name),
    description: trimmed(o.description),
    examples: Array.isArray(o.examples) ? (o.examples as string[]).map((e) => e.trim()) : [],
    publicCard: o.public_card === true,
    input: o.input === undefined || o.input === null ? null : (o.input as Record<string, unknown> | boolean),
    // Only when written: a block without it reads as it did before 5 Nov 2026.
    ...(Array.isArray(o.accept_risk) ? { acceptRisk: [...new Set((o.accept_risk as string[]).map((e) => e.trim()))] } : {}),
  };
}

/** Is this flow open to A2A callers (who also hold a key naming it)? */
export function isA2aPublished(p: A2aPublication | null | undefined): p is A2aPublication {
  return Boolean(p && p.publish);
}
