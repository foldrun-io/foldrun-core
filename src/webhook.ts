// Per-flow webhook tokens, derived rather than stored: HMAC of the flow's
// identity under the install's secret key. Stable across restarts, unique
// per flow, and rotating FOLDRUN_SECRET_KEY invalidates every hook at once.

import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "./paths.ts";
import { workspaceDir } from "./store.ts";
import crypto from "node:crypto";

const keyFile = () => path.join(dataRoot(), ".secret-key");

/**
 * The install's secret key. Every derived token — flow hooks, git secrets —
 * hangs off this one value, so rotating it invalidates all of them together.
 */
export function installKey(): string {
  if (process.env.FOLDRUN_SECRET_KEY) return process.env.FOLDRUN_SECRET_KEY;
  if (fs.existsSync(keyFile())) return fs.readFileSync(keyFile(), "utf8");
  // secrets.ts creates this on first use; fall back to a fixed dev value so
  // hook URLs stay stable before any secret has been set.
  return "foldrun-dev-install";
}

// Per-hook rotation without storing tokens: what is stored is a generation
// counter, and the token is derived from identity + generation. Rotating a
// hook that leaked is one increment; the old token dies instantly; nothing
// secret ever sits in the file. Generation 0 keeps the original formula, so
// every hook URL handed out before rotation existed still works.

interface HookState {
  gen: number;
  rotatedAt: string;
}

function hooksFile(tenant: string, workspace: string) {
  return path.join(workspaceDir(tenant, workspace), "hooks.json");
}

function readHooks(tenant: string, workspace: string): Record<string, HookState> {
  const file = hooksFile(tenant, workspace);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function hookGeneration(tenant: string, workspace: string, flow: string): number {
  return readHooks(tenant, workspace)[flow]?.gen ?? 0;
}

/** Invalidate a hook's URL and mint the next one. Returns the new path. */
export function rotateWebhook(tenant: string, workspace: string, flow: string): string {
  const hooks = readHooks(tenant, workspace);
  hooks[flow] = { gen: (hooks[flow]?.gen ?? 0) + 1, rotatedAt: new Date().toISOString() };
  const file = hooksFile(tenant, workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(hooks, null, 2));
  return webhookPath(tenant, workspace, flow);
}

export function webhookToken(tenant: string, workspace: string, flow: string): string {
  const gen = hookGeneration(tenant, workspace, flow);
  const identity = gen === 0 ? `${tenant}/${workspace}/${flow}` : `${tenant}/${workspace}/${flow}#${gen}`;
  return crypto.createHmac("sha256", installKey()).update(identity).digest("hex").slice(0, 32);
}

export function webhookPath(tenant: string, workspace: string, flow: string): string {
  return `/api/hooks/${tenant}/${workspace}/${flow}?token=${webhookToken(tenant, workspace, flow)}`;
}

// ---------- one-click approval ----------

/**
 * The token in an emailed approve/reject link. Same shape as a hook token:
 * derived from the run's identity under the install key, never stored, so
 * a link keeps working across restarts and dies with a key rotation. A run
 * id is unique, so there is no generation counter — a leaked link is dealt
 * with by deciding the run, after which the link does nothing.
 *
 * The `approve:` prefix keeps this HMAC family apart from the hook family:
 * without it a run id that happened to spell `tenant/ws/flow` would mint a
 * working hook token.
 */
export function approveToken(tenant: string, workspace: string, runId: string): string {
  return crypto
    .createHmac("sha256", installKey())
    .update(`approve:${tenant}/${workspace}/${runId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * The token that releases a run parked on `wait: event`. Its own HMAC
 * family, so an approval link cannot double as an event URL or the reverse.
 */
export function eventToken(tenant: string, workspace: string, runId: string): string {
  return crypto
    .createHmac("sha256", installKey())
    .update(`event:${tenant}/${workspace}/${runId}`)
    .digest("hex")
    .slice(0, 32);
}

/** The URL a `wait: event` step is released at — absolute when the install
 *  knows its origin, a path otherwise. */
export function eventUrl(tenant: string, workspace: string, runId: string): string {
  const p = `/api/events/${tenant}/${workspace}/${runId}?token=${eventToken(tenant, workspace, runId)}`;
  const base = publicUrl();
  return base ? `${base}${p}` : p;
}

/**
 * Where this install can be reached from outside, or null. The platform has
 * never needed to know its own address — every URL it hands out has been a
 * path, completed by whoever pasted it. A link in an email has no such
 * reader, so this is the one place an absolute origin is required.
 */
export function publicUrl(): string | null {
  const raw = process.env.FOLDRUN_PUBLIC_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

// ---------- delivery log ----------

// Every POST at a hook URL, kept: accepted ones with their run id, refused
// ones with why. A webhook that "never fires" is indistinguishable from one
// that fires and is refused — unless someone wrote down the refusals.

export interface HookDelivery {
  t: string;
  flow: string;
  outcome: "accepted" | "invalid-token" | "invalid-signature" | "not-webhook" | "no-flow" | "error";
  runId?: string;
  bytes?: number;
  detail?: string;
}

function deliveriesFile(tenant: string, workspace: string) {
  return path.join(workspaceDir(tenant, workspace), "hook-deliveries.jsonl");
}

const KEEP_DELIVERIES = 500;

export function recordDelivery(tenant: string, workspace: string, delivery: HookDelivery) {
  const file = deliveriesFile(tenant, workspace);
  if (!fs.existsSync(path.dirname(file))) return; // no workspace, nothing to log against
  fs.appendFileSync(file, JSON.stringify(delivery) + "\n");
  // Bounded: compact to the newest KEEP when it doubles. Amortised cheap,
  // and a log that grows forever is a disk-full incident with a delay.
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > KEEP_DELIVERIES * 2) {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, lines.slice(-KEEP_DELIVERIES).join("\n") + "\n");
      fs.renameSync(tmp, file);
    }
  } catch {
    // compaction is best-effort; the append already landed
  }
}

export function readDeliveries(tenant: string, workspace: string, limit = 20): HookDelivery[] {
  const file = deliveriesFile(tenant, workspace);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line) as HookDelivery;
      } catch {
        return null;
      }
    })
    .filter((d): d is HookDelivery => d !== null);
}
