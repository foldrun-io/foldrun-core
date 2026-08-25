// Materialising @file secrets to disk.
//
// An SSH private key and a client certificate are credentials tools read
// from a path — ssh flatly refuses a key that isn't 0600, curl wants
// --cert a file. So a @file secret's env var carries the *path*, not the
// bytes, and the content is written into a per-run scratch directory the
// step can reach and the platform cleans up. The directory is inside the
// agent's own tree (so it crosses into a container with the workspace) but
// dot-prefixed and never archived — it holds live credentials.

import fs from "node:fs";
import path from "node:path";
import { isFileValue, fileContent } from "./secrets.ts";

/**
 * Turn any @file values in `env` into files under `<agentDir>/.secret-files`,
 * rewriting each to its path. Returns the directory written (for cleanup)
 * and the transformed env. Non-file values pass through untouched.
 */
export function materializeFileSecrets(
  agentDir: string,
  env: Record<string, string>,
): { env: Record<string, string>; dir: string | null } {
  const fileEntries = Object.entries(env).filter(
    ([, v]) => typeof v === "string" && isFileValue(v),
  );
  if (fileEntries.length === 0) return { env, dir: null };

  const dir = path.join(agentDir, ".secret-files");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = { ...env };
  for (const [name, value] of fileEntries) {
    // Lowercased name as the filename keeps it predictable without leaking
    // the value; the env var still points at it by absolute path.
    const file = path.join(dir, name.toLowerCase());
    fs.writeFileSync(file, fileContent(value), { mode: 0o600 });
    out[name] = file;
  }
  return { env: out, dir };
}

/** Best-effort removal of a materialised secret-files directory. */
export function cleanupFileSecrets(dir: string | null) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
