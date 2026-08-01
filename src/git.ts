// git push → deployed.
//
// A workspace is markdown, so there is no build to run: a push is a fetch of
// the tree at that commit, a check, and a swap. This module is the GitHub half
// — the secret a repository signs with, the payload shape, and pulling the
// tarball. `deploy.ts` decides whether the result is allowed to go live.
//
// The tarball, not a clone: one HTTP call, no git binary, no working copy kept
// on the server. A markdown workspace is a few hundred kilobytes.

import crypto from "node:crypto";
import { installKey } from "./webhook.ts";

/** GitHub refuses to fetch anything larger, and neither should we. */
const MAX_TARBALL = 25 * 1024 * 1024;

/**
 * The secret a repository signs its pushes with.
 *
 * Derived rather than stored, exactly like a flow's webhook token: HMAC of the
 * workspace's identity under the install key. Nothing new to persist, unique
 * per workspace, and rotating MDAGENT_SECRET_KEY invalidates every connection
 * at once.
 */
export function gitSecret(tenant: string, workspace: string): string {
  return crypto
    .createHmac("sha256", installKey())
    .update(`git/${tenant}/${workspace}`)
    .digest("hex");
}

export function gitHookPath(tenant: string, workspace: string): string {
  return `/api/git/${tenant}/${workspace}`;
}

/**
 * Whether a request really came from the repository it claims to.
 *
 * Compared in constant time: a byte-by-byte early return leaks the expected
 * signature to anyone willing to time enough requests. The raw body is
 * required — re-serializing parsed JSON changes bytes GitHub signed.
 */
export function verifySignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!header) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface PushEvent {
  repo: string;
  /** Full ref, e.g. refs/heads/main. */
  ref: string;
  branch: string;
  commit: string;
  message: string | null;
  pusher: string | null;
}

/** What we need out of a GitHub push payload, or null if it isn't one. */
export function parsePush(payload: unknown): PushEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, any>;
  const repo = p.repository?.full_name;
  const ref = p.ref;
  const commit = p.after;
  if (typeof repo !== "string" || typeof ref !== "string" || typeof commit !== "string") {
    return null;
  }
  // A deleted branch reports all zeros and ships no tree.
  if (/^0+$/.test(commit)) return null;
  return {
    repo,
    ref,
    branch: ref.replace(/^refs\/heads\//, ""),
    commit,
    message: typeof p.head_commit?.message === "string" ? p.head_commit.message : null,
    pusher: typeof p.pusher?.name === "string" ? p.pusher.name : null,
  };
}

/**
 * The repository at one commit, as a gzipped tarball.
 *
 * A token is only needed for a private repository. It is read from the
 * environment rather than taken as an argument so a caller cannot be tricked
 * into forwarding one somewhere else.
 */
export async function fetchTarball(repo: string, commit: string): Promise<Buffer> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`refusing to fetch "${repo}"`);
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error(`refusing to fetch commit "${commit}"`);

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "mdagent",
    "x-github-api-version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/repos/${repo}/tarball/${commit}`, { headers });
  if (!res.ok) {
    throw new Error(
      `GitHub returned ${res.status} for ${repo}@${commit.slice(0, 8)}` +
        (res.status === 404 && !token
          ? " — a private repository needs GITHUB_TOKEN set on the server"
          : ""),
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_TARBALL) {
    throw new Error(`${repo} is ${Math.round(buf.length / 1e6)}MB — too large to deploy`);
  }
  return buf;
}
