// What a pod's copy of a workspace was last brought to (FOL-126, 13 Nov 2026):
// the two head ids and every file's sha as the heads held them. The mirror
// (workspace-mirror.ts) writes it after a sync; the reconcile reads it so a
// file that differs from it is this pod's own change, and one that differs
// only from the head is someone else's, not yet copied here.
//
// Kept on the pod's own disk beside the folders, outside every workspace:
// <data>/.mirror/<tenant>/<workspace>.json. Lost with the disk, it is rebuilt
// by the next full sync (a pod starts with an empty disk anyway).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataRoot } from "./paths.ts";
import { processState } from "./process-state.ts";

export interface MirrorBase {
  workspaceHead: string | null;
  stateHead: string | null;
  /** path → what the heads held for it at that sync (a path's base when this
   *  pod's change to it is published). */
  files: Record<string, { sha: string; mode: number }>;
  at: string;
}

const GATE = processState("mirror-gate", () => ({ on: (() => false) as () => boolean }));

/** The platform says whether this pod's folders are a copy of the heads
 *  (`revisions.mirror`). Off on a laptop, in the CLI and until switched on. */
export function setMirrorGate(fn: (() => boolean) | null): void {
  GATE.on = fn ?? (() => false);
}

export function mirrorOn(): boolean {
  try {
    return GATE.on();
  } catch {
    return false;
  }
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const mirrorBaseFile = (tenant: string, workspace: string): string | null =>
  SAFE.test(tenant) && SAFE.test(workspace) ? path.join(dataRoot(), ".mirror", tenant, `${workspace}.json`) : null;

export function readMirrorBase(tenant: string, workspace: string): MirrorBase | null {
  const f = mirrorBaseFile(tenant, workspace);
  if (!f) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as MirrorBase;
  } catch {
    return null;
  }
}

export function writeMirrorBase(tenant: string, workspace: string, base: MirrorBase): void {
  const f = mirrorBaseFile(tenant, workspace);
  if (!f) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(base));
  fs.renameSync(tmp, f);
}

export function dropMirrorBase(tenant: string, workspace: string): void {
  const f = mirrorBaseFile(tenant, workspace);
  if (f) fs.rmSync(f, { force: true });
}

/** Every workspace this pod holds a copy of, by its base files. */
export function mirroredWorkspaces(): { tenant: string; workspace: string }[] {
  const root = path.join(dataRoot(), ".mirror");
  const out: { tenant: string; workspace: string }[] = [];
  let tenants: string[] = [];
  try {
    tenants = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const tenant of tenants) {
    if (!SAFE.test(tenant)) continue;
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(root, tenant));
    } catch {
      continue;
    }
    for (const f of files) if (f.endsWith(".json") && SAFE.test(f.slice(0, -5))) out.push({ tenant, workspace: f.slice(0, -5) });
  }
  return out;
}
