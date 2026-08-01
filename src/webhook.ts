// Per-flow webhook tokens, derived rather than stored: HMAC of the flow's
// identity under the install's secret key. Stable across restarts, unique
// per flow, and rotating MDAGENT_SECRET_KEY invalidates every hook at once.

import fs from "node:fs";
import path from "node:path";
import { dataRoot } from "./paths.ts";
import crypto from "node:crypto";

const keyFile = () => path.join(dataRoot(), ".secret-key");

function installKey(): string {
  if (process.env.MDAGENT_SECRET_KEY) return process.env.MDAGENT_SECRET_KEY;
  if (fs.existsSync(keyFile())) return fs.readFileSync(keyFile(), "utf8");
  // secrets.ts creates this on first use; fall back to a fixed dev value so
  // hook URLs stay stable before any secret has been set.
  return "mdagent-dev-install";
}

export function webhookToken(tenant: string, workspace: string, flow: string): string {
  return crypto
    .createHmac("sha256", installKey())
    .update(`${tenant}/${workspace}/${flow}`)
    .digest("hex")
    .slice(0, 32);
}

export function webhookPath(tenant: string, workspace: string, flow: string): string {
  return `/api/hooks/${tenant}/${workspace}/${flow}?token=${webhookToken(tenant, workspace, flow)}`;
}
