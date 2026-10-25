// The root half of the `install` tool: a tiny server the run container's root
// start-up leaves running before it drops to the agent user.
//
//   node install-helper.js <socket> <runtime cache dir>
//
// The agent never becomes root. It can only ask this process, over a unix
// socket, to install Debian packages BY NAME — each name re-checked against
// Debian's naming rule here, so nothing but a package name reaches apt, and
// apt is driven by the same snippet the start-up uses (systemInstallSh): the
// account's .deb cache and snapshots, so a package anyone installed before is
// restored in about a second. Requests are served one at a time; the process
// dies with the container.
//
// pip and npm need no root and are installed by the tool itself, as the agent.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DEB_PACKAGE, systemInstallSh, summarizeInstallFailure } from "./runtime.ts";

export interface InstallRequest {
  manager: "apt";
  packages: string[];
}

export interface InstallReply {
  ok: boolean;
  /** "snapshot" | "apt" */
  mode?: string;
  seconds?: number;
  error?: string;
}

/** Validate one request; null when it may run. Exported for the tests. */
export function refuse(req: unknown): string | null {
  const r = req as Partial<InstallRequest> | null;
  if (!r || typeof r !== "object") return "not a request";
  if (r.manager !== "apt") return "this helper installs Debian packages (manager: apt) only";
  if (!Array.isArray(r.packages) || r.packages.length === 0) return "no packages named";
  if (r.packages.length > 50) return "at most 50 packages per request";
  const bad = r.packages.filter((p) => typeof p !== "string" || !DEB_PACKAGE.test(p));
  if (bad.length) return `not Debian package names: ${bad.map(String).join(", ")}`;
  return null;
}

/** Install one validated request with the start-up's own snippet. */
export function installApt(packages: string[], cacheDir: string): Promise<InstallReply> {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-install-"));
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", systemInstallSh(cacheDir, logDir)], {
      env: { ...process.env, FOLDRUN_SYSTEM_PACKAGES: packages.join(" ") },
      stdio: "ignore",
    });
    child.on("close", () => {
      let status: { ok?: boolean; mode?: string; seconds?: number } = {};
      try {
        status = JSON.parse(fs.readFileSync(path.join(logDir, "system-install.json"), "utf8"));
      } catch {
        status = { ok: false };
      }
      let log = "";
      try {
        log = fs.readFileSync(path.join(logDir, "system-install.log"), "utf8");
      } catch {
        log = "";
      }
      fs.rmSync(logDir, { recursive: true, force: true });
      resolve(
        status.ok
          ? { ok: true, mode: status.mode, seconds: status.seconds }
          : { ok: false, error: summarizeInstallFailure("apt-get install", log || "no output") },
      );
    });
    child.on("error", (err) => {
      fs.rmSync(logDir, { recursive: true, force: true });
      resolve({ ok: false, error: `could not run the installer: ${err.message}` });
    });
  });
}

export function serve(socket: string, cacheDir: string): net.Server {
  try {
    fs.rmSync(socket, { force: true });
  } catch {
    /* nothing there */
  }
  let queue: Promise<unknown> = Promise.resolve();
  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.length > 64_000) {
        conn.end(JSON.stringify({ ok: false, error: "request too large" }) + "\n");
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = "";
      let req: unknown;
      try {
        req = JSON.parse(line);
      } catch {
        conn.end(JSON.stringify({ ok: false, error: "not JSON" }) + "\n");
        return;
      }
      const why = refuse(req);
      if (why) {
        conn.end(JSON.stringify({ ok: false, error: why }) + "\n");
        return;
      }
      // One install at a time: apt holds a lock, and two dpkg runs in one
      // container would fight over it.
      queue = queue.then(async () => {
        const reply = await installApt((req as InstallRequest).packages, cacheDir);
        conn.end(JSON.stringify(reply) + "\n");
      });
    });
    conn.on("error", () => {
      /* the client went away */
    });
  });
  server.listen(socket, () => {
    // The agent user must be able to connect; nothing else runs in here.
    try {
      fs.chmodSync(socket, 0o666);
    } catch {
      /* best effort */
    }
  });
  return server;
}

if (process.argv[1] && /install-helper\.(js|ts|mjs)$/.test(process.argv[1])) {
  const [socket, cacheDir] = process.argv.slice(2);
  if (!socket || !cacheDir) {
    console.error("usage: install-helper <socket> <runtime cache dir>");
    process.exit(2);
  }
  serve(socket, cacheDir);
}
