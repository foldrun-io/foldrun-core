// Does this credential still work?
//
// The vault knows a secret's name, its scope and its shape. It knows nothing
// about whether the thing on the other end still accepts it, and that is the
// only question anyone actually has. A key that has quietly stopped working
// looks identical to a key nobody has used yet, and both look identical to a
// key that is fine — three very different situations rendered the same way.
//
// Two facts, recorded where they are already known and nowhere else:
//
//   when it was last used, and against which host
//   what the other end said the last time — accepted, or refused
//
// The egress proxy sees both for every http tool and every model call,
// because filling the credential is its whole job. Notifications and the
// provider check report their own. Nothing new is instrumented, and a secret
// materialised into a sandbox reports nothing, which the page says plainly
// rather than guessing.
//
// Never the value, never a hash of the value, never the request body. A
// name, a host, a status and a time.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { accountDir } from "./store.ts";

/** How a credential is identified here. A name alone is not enough: the
 *  account and each workspace can hold a secret by the same name, and they
 *  are different credentials with different health. */
export function healthKey(name: string, scope: "account" | "workspace", workspace?: string | null): string {
  return scope === "workspace" && workspace ? `workspace:${workspace}:${name}` : `account:${name}`;
}

export interface SecretUse {
  /** ISO time of the most recent use. */
  at: string;
  /** The host it was sent to, so "which of my four keys is this" has an
   *  answer without opening a run. */
  host: string;
  /** The response status, when there was one. */
  status: number | null;
  /** Refused means the credential itself was rejected: 401, 402 or 403.
   *  A 500 is the other end failing, which says nothing about the key. */
  outcome: "accepted" | "refused" | "error";
}

export interface SecretRecord {
  last: SecretUse;
  /** Consecutive refusals, newest first — one is a fluke, five is a dead
   *  key. Reset by any acceptance. */
  refusals: number;
  /** The last acceptance, kept through a run of refusals so a page can say
   *  "worked until Tuesday", which is the sentence that dates the breakage. */
  lastAccepted: string | null;
}

type HealthFile = Record<string, SecretRecord>;

const healthFile = (tenant: string) => path.join(accountDir(tenant), "secret-health.json");

function read(tenant: string): HealthFile {
  try {
    return JSON.parse(fs.readFileSync(healthFile(tenant), "utf8")) as HealthFile;
  } catch {
    return {};
  }
}

function write(tenant: string, data: HealthFile): void {
  const file = healthFile(tenant);
  if (!fs.existsSync(path.dirname(file))) return;
  // pid alone is not unique across pods on a shared volume.
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Writes are queued and coalesced off the caller's path. The egress proxy
// notes a use per secret per request, before it streams the response body,
// and a synchronous read-modify-write of a JSON file there is latency on
// every proxied call — "never blocks" has to be true, not aspirational.
// One writer per process; the queue drains in order.
const pending = new Map<string, { name: string; use: { host: string; status: number | null; at?: string } }[]>();
let draining = false;

function drain(): void {
  if (draining) return;
  draining = true;
  setImmediate(() => {
    try {
      for (const [tenant, uses] of pending) {
        pending.delete(tenant);
        const data = read(tenant);
        for (const { name, use } of uses) apply(data, name, use);
        write(tenant, data);
      }
    } catch {
      // best effort, always
    } finally {
      draining = false;
      if (pending.size) drain();
    }
  });
}

function apply(data: HealthFile, name: string, use: { host: string; status: number | null; at?: string }): void {
  const outcome = outcomeFor(use.status);
  const at = use.at ?? new Date().toISOString();
  const prev = data[name];
  data[name] = {
    last: { at, host: use.host, status: use.status, outcome },
    // Only a refusal counts against a key. An error at the other end is
    // the other end's problem and must not accumulate into a false alarm.
    refusals: outcome === "refused" ? (prev?.refusals ?? 0) + 1 : outcome === "accepted" ? 0 : prev?.refusals ?? 0,
    lastAccepted: outcome === "accepted" ? at : prev?.lastAccepted ?? null,
  };
}

/** 401, 402 and 403 are the credential being refused. Everything else is
 *  the request, the model or the provider — none of which is the key's
 *  fault, and calling them a credential failure would send people to
 *  rotate a key that was never the problem. */
export function outcomeFor(status: number | null): SecretUse["outcome"] {
  if (status === null) return "error";
  if (status === 401 || status === 402 || status === 403) return "refused";
  if (status >= 200 && status < 400) return "accepted";
  return "error";
}

/**
 * Record one use. `key` is a health key (see healthKey), never a bare name.
 * Never throws and never blocks: the write is queued and happens off the
 * caller's path, because this runs on every proxied request.
 */
export function noteSecretUse(
  tenant: string,
  key: string,
  use: { host: string; status: number | null; at?: string },
): void {
  if (!key) return;
  const list = pending.get(tenant) ?? [];
  list.push({ name: key, use: { ...use, at: use.at ?? new Date().toISOString() } });
  pending.set(tenant, list);
  drain();
}

/** Wait for queued writes to land — for tests, and for a process that is
 *  about to exit. */
export function flushSecretHealth(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => (pending.size === 0 && !draining ? resolve() : setImmediate(check));
    check();
  });
}

/** Everything known about this account's credentials, by name. Names the
 *  vault holds but nothing has used are simply absent, which is the honest
 *  answer: unused is not the same as broken. */
export function secretHealth(tenant: string): HealthFile {
  return read(tenant);
}

/** The credentials worth saying something about: refused the last time they
 *  were used. Sorted worst first — most consecutive refusals, then oldest
 *  last-success, which is the order someone would work through them. */
export function failingSecrets(tenant: string): { name: string; record: SecretRecord }[] {
  return Object.entries(read(tenant))
    .filter(([, r]) => r.last.outcome === "refused")
    .map(([name, record]) => ({ name, record }))
    .sort((a, b) => b.record.refusals - a.record.refusals || (a.record.lastAccepted ?? "").localeCompare(b.record.lastAccepted ?? ""));
}

/** Drop what is known about a secret — for a delete, and for a rotation,
 *  where the old key's refusals say nothing about the new one. */
export function forgetSecretHealth(tenant: string, name: string): void {
  try {
    const data = read(tenant);
    if (!(name in data)) return;
    delete data[name];
    write(tenant, data);
  } catch {
    // best effort
  }
}
