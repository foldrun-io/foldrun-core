// Materialising config-shaped secrets (@file, @ssh, @api) into a run.
//
// An SSH private key and a client certificate are credentials tools read
// from a path — ssh flatly refuses a key that isn't 0600, curl wants
// --cert a file. And an SSH or API *connection* is more than a value: host,
// port, user, headers. The user describes the connection; this layer turns
// it into something directly runnable — a 0600 file, or a 0700 wrapper
// script — and the env var carries the *path*. The agent runs
// `"$PROD_VM" 'uptime'` or `"$STRIPE" /v1/charges` and never learns whether
// it was key or password, one header or five.
//
// Everything lands in a per-run scratch directory inside the agent's own
// tree (so it crosses into a container with the workspace) but dot-prefixed
// and never archived or copied back — it holds live credentials.

import fs from "node:fs";
import path from "node:path";
import {
  isFileValue, fileContent,
  isSshValue, sshConfigOf,
  isApiValue, apiConfigOf,
} from "./secrets.ts";

// POSIX single-quoting: the one escape sh actually honours inside ' is none,
// so close, backslash-quote, reopen. Wrapper scripts embed hosts, users and
// header values through this and nothing else.
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function writeWrapper(dir: string, name: string, body: string): string {
  const file = path.join(dir, name.toLowerCase());
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  return file;
}

/**
 * Turn any @file/@ssh/@api values in `env` into files under
 * `<agentDir>/.secret-files`, rewriting each to its path. Returns the
 * directory written (for cleanup) and the transformed env. Plain values
 * pass through untouched.
 */
export function materializeFileSecrets(
  agentDir: string,
  env: Record<string, string>,
): { env: Record<string, string>; dir: string | null } {
  const entries = Object.entries(env).filter(
    ([, v]) => typeof v === "string" && (isFileValue(v) || isSshValue(v) || isApiValue(v)),
  );
  if (entries.length === 0) return { env, dir: null };

  const dir = path.join(agentDir, ".secret-files");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = { ...env };
  for (const [name, value] of entries) {
    // Lowercased name as the filename keeps it predictable without leaking
    // the value; the env var still points at it by absolute path.
    if (isFileValue(value)) {
      const file = path.join(dir, name.toLowerCase());
      fs.writeFileSync(file, fileContent(value), { mode: 0o600 });
      out[name] = file;
    } else if (isSshValue(value)) {
      const ssh = sshConfigOf(value);
      const dest = `${ssh.user}@${ssh.host}`;
      const opts = `-p ${ssh.port ?? 22} -o StrictHostKeyChecking=accept-new`;
      let cmd: string;
      if (ssh.private_key) {
        const key = path.join(dir, `${name.toLowerCase()}.key`);
        // ssh wants a trailing newline on OpenSSH keys and 0600 or it balks.
        fs.writeFileSync(key, ssh.private_key.replace(/\n?$/, "\n"), { mode: 0o600 });
        cmd = `exec ssh -i ${q(key)} ${opts} ${q(dest)} "$@"`;
        out[`${name}_KEY`] = key;
      } else {
        const pw = path.join(dir, `${name.toLowerCase()}.pw`);
        fs.writeFileSync(pw, ssh.password ?? "", { mode: 0o600 });
        cmd = `exec sshpass -f ${q(pw)} ssh ${opts} ${q(dest)} "$@"`;
      }
      out[name] = writeWrapper(dir, name, cmd);
      // The parts, for scp/rsync/anything the wrapper doesn't cover.
      out[`${name}_HOST`] = ssh.host;
      out[`${name}_PORT`] = String(ssh.port ?? 22);
      out[`${name}_USER`] = ssh.user;
    } else {
      const api = apiConfigOf(value);
      const headers = Object.entries(api.headers)
        .map(([h, v]) => `-H ${q(`${h}: ${v}`)}`)
        .join(" ");
      // With a base URL, a path-shaped first argument gets prefixed — so
      // `"$STRIPE" /v1/charges` and `"$STRIPE" https://elsewhere` both work.
      const prefix = api.base_url
        ? `case "$1" in /*) _u=${q(api.base_url)}"$1"; shift; set -- "$_u" "$@";; esac\n`
        : "";
      out[name] = writeWrapper(dir, name, `${prefix}exec curl -sS ${headers} "$@"`);
      if (api.base_url) out[`${name}_URL`] = api.base_url;
    }
  }
  return { env: out, dir };
}

/** Best-effort removal of a materialised secret-files directory. */
export function cleanupFileSecrets(dir: string | null) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
