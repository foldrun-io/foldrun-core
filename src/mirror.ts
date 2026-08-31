// Mirror a workspace's main to another remote — GitHub, GitLab, anywhere.
//
// For people who want reviews, CI or a second copy where they already work.
// The platform stays the remote of record; the mirror is a push-only copy
// updated after every commit here, whether that commit was a dashboard save
// or a push. Set on the Repository page; the token is a workspace secret
// named MIRROR_TOKEN, resolved at push time and never written anywhere.

import fs from "node:fs";
import path from "node:path";
import { registerAfterCommit } from "./history.ts";
import { pushMirror, repoDir, repoExists } from "./gitrepo.ts";
import { workspaceDir } from "./store.ts";
import { resolveSecrets } from "./secrets.ts";

export interface RepoSettings {
  /** An HTTPS remote URL, without credentials. */
  mirror?: string | null;
}

const settingsFile = (tenant: string, workspace: string) => path.join(workspaceDir(tenant, workspace), ".repo.json");

export function readRepoSettings(tenant: string, workspace: string): RepoSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(tenant, workspace), "utf8")) as RepoSettings;
  } catch {
    return {};
  }
}

export function writeRepoSettings(tenant: string, workspace: string, next: RepoSettings) {
  const url = next.mirror?.trim();
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("the mirror must be an https:// URL");
    }
    if (parsed.protocol !== "https:") throw new Error("the mirror must be an https:// URL");
    if (parsed.username || parsed.password) throw new Error("leave credentials out of the URL — set the MIRROR_TOKEN secret instead");
  }
  fs.writeFileSync(settingsFile(tenant, workspace), `${JSON.stringify({ mirror: url || null }, null, 2)}\n`);
}

export interface MirrorStatus {
  at: string;
  sha: string;
  ok: boolean;
  detail: string;
}

export function lastMirror(tenant: string, workspace: string): MirrorStatus | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoDir(tenant, workspace), "foldrun-last-mirror.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Push main to the configured mirror now. Returns what happened. */
export function mirrorNow(tenant: string, workspace: string, sha: string): MirrorStatus | null {
  const { mirror } = readRepoSettings(tenant, workspace);
  if (!mirror || !repoExists(tenant, workspace)) return null;
  const { env, missing } = resolveSecrets(tenant, ["MIRROR_TOKEN"], workspace);
  let result: { ok: boolean; detail: string };
  if (missing.length) {
    result = { ok: false, detail: "MIRROR_TOKEN is not set — add it under Secrets" };
  } else {
    const u = new URL(mirror);
    // GitHub and GitLab both accept a token as the password with any username.
    u.username = "foldrun";
    u.password = env.MIRROR_TOKEN;
    result = pushMirror(tenant, workspace, u.toString());
  }
  const status: MirrorStatus = { at: new Date().toISOString(), sha, ...result };
  fs.writeFileSync(path.join(repoDir(tenant, workspace), "foldrun-last-mirror.json"), JSON.stringify(status));
  return status;
}

// After every commit to a workspace's main, mirror it — off the request
// path, because a mirror push is a network call to someone else's server.
registerAfterCommit((tenant, scope, sha) => {
  if (scope === "@library") return;
  if (!readRepoSettings(tenant, scope).mirror) return;
  setTimeout(() => {
    try {
      mirrorNow(tenant, scope, sha);
    } catch {
      // recorded by mirrorNow where it can; never surfaces as a failed save
    }
  }, 0);
});
