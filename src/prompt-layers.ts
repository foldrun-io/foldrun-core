// The system prompt in layers, ordered for the model's prompt cache.
//
// Every provider caches a prompt by its prefix: a request whose opening
// bytes match one it has seen reads the model's work on them instead of
// paying for it again, and a byte that differs invalidates everything
// after it. agentContext used to join its sections in the order it
// computed them, which put the memory index, the state file list and the
// clock — the three things that change between runs — in the middle.
//
// This collector keeps the sections apart by how often they change and
// assembles them stable first, dynamic last: what Anthropic does for
// Claude Code ("static content first, dynamic content last"). The prompt
// still goes to the SDK as one string, cached as one block. The Agent
// SDK's SYSTEM_PROMPT_DYNAMIC_BOUNDARY would split it, but the CLI honours
// the marker only when it talks to api.anthropic.com directly — a step
// behind the egress proxy got one block anyway (live check, 20 Oct 2026;
// claude-code issue #102518) — and where it does split, it sends the
// stable half with the CLI's "global" cache scope, which is not a scope to
// put an account's own prose in. So no marker.
//
// Each layer is also hashed, and the hashes ride on the step record
// (`promptLayers`). A step whose cache writes are high can then say which
// layer changed since the agent's last step — "memory changed" — instead
// of leaving a person to diff two 40k-character prompts.

import crypto from "node:crypto";
import type { PromptLayerRecord } from "./tokens.ts";

// The record's shape and the readers' comparison live in tokens.ts, which
// has no node imports and is what the dashboard's client bundle reads.
export { promptLayersChanged, promptCacheNote, type PromptLayerRecord } from "./tokens.ts";

export interface AssembledPrompt {
  /** The whole prompt, stable layers first. */
  text: string;
  layers: PromptLayerRecord[];
}

const SEP = "\n\n";

export function hashLayer(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * A collector agentContext fills in whatever order it computes its
 * sections. `add` with the same name twice appends to that layer, so a
 * section built in two places (the platform's rules) is one layer.
 */
export class PromptLayers {
  private readonly order: string[] = [];
  private readonly text = new Map<string, string[]>();
  private readonly dynamic = new Set<string>();

  add(name: string, text: string, opts: { dynamic?: boolean } = {}): void {
    if (!text) return;
    if (!this.text.has(name)) {
      this.order.push(name);
      this.text.set(name, []);
    }
    this.text.get(name)!.push(text);
    if (opts.dynamic) this.dynamic.add(name);
  }

  assemble(): AssembledPrompt {
    const parts: string[] = [];
    const layers: PromptLayerRecord[] = [];
    const take = (names: string[], isDynamic: boolean) => {
      for (const name of names) {
        const joined = this.text.get(name)!.join(SEP);
        parts.push(joined);
        layers.push({ name, chars: joined.length, hash: hashLayer(joined), ...(isDynamic ? { stable: false } : {}) });
      }
    };
    take(this.order.filter((n) => !this.dynamic.has(n)), false);
    take(this.order.filter((n) => this.dynamic.has(n)), true);
    return { text: parts.join(SEP), layers };
  }
}

/**
 * The key an OpenAI-format provider routes a prompt by (`prompt_cache_key`).
 * One per agent: every step of an agent opens with the same prefix, and a
 * key that names the account keeps one tenant's cache from being probed
 * through another's requests. Hashed, since the names are a person's and
 * the parameter is capped at 64 characters.
 */
export function promptCacheKey(tenant: string, workspace: string, agent: string): string {
  return `fr-${crypto.createHash("sha256").update(`${tenant}\u0000${workspace}\u0000${agent}`).digest("hex").slice(0, 32)}`;
}
