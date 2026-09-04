// Preview workspaces: a branch pushed to a workspace's repository becomes a
// throwaway workspace named after it (`<ws>-preview-<branch>`), deployed from the branch's tree, with
// its evals run against it — the way a preview deployment answers a branch
// push on a hosting platform. Delete the branch and the preview goes with it.
//
// A preview is a full workspace, so everything that reads a workspace works
// on it: the run page, the graph, the CLI. Two things are different, and
// both are read from the marker written beside the workspace directory
// (the same place the deployed-commit marker lives, outside the tree a
// deploy replaces): the scheduler never fires a preview's flows, because a
// copy of a nightly desk that also runs nightly doubles the bill; and a
// preview reads its source workspace's secrets, because a branch is the
// same team's work and asking them to copy every credential first would
// mean nobody ever used this.

import fs from "node:fs";
import path from "node:path";
import { assertSafeName, deleteWorkspace, workspaceDir } from "./store.ts";
import { deployWorkspace, type DeployIssue } from "./deploy.ts";
import { filesAt, repoDir, type RefInfo } from "./gitrepo.ts";

/** Between the source's name and the branch's slug. A workspace name is
 *  kebab-case, so a double dash is not available; the word is. The marker
 *  beside the directory, not the name, is what says which source it is. */
export const PREVIEW_SEP = "-preview-";

const MAX_NAME = 63;

/** The workspace a branch previews into: `<source>--<branch-slug>`. */
export function previewName(source: string, branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const room = MAX_NAME - source.length - PREVIEW_SEP.length;
  const cut = slug.slice(0, Math.max(1, room)).replace(/-+$/, "");
  const name = `${source}${PREVIEW_SEP}${cut || "branch"}`;
  assertSafeName(name, "preview workspace");
  return name;
}

export interface PreviewMarker {
  source: string;
  branch: string;
  commit: string;
  at: string;
}

const markerPath = (tenant: string, workspace: string) =>
  path.join(workspaceDir(tenant, workspace), "..", `.${workspace}.preview.json`);

export function readPreview(tenant: string, workspace: string): PreviewMarker | null {
  try {
    return JSON.parse(fs.readFileSync(markerPath(tenant, workspace), "utf8")) as PreviewMarker;
  } catch {
    return null;
  }
}

export function isPreview(tenant: string, workspace: string): boolean {
  return readPreview(tenant, workspace) !== null;
}

/** Every preview cut from one source workspace. */
export function previewsOf(tenant: string, source: string): (PreviewMarker & { workspace: string })[] {
  const root = path.join(workspaceDir(tenant, source), "..");
  if (!fs.existsSync(root)) return [];
  const out: (PreviewMarker & { workspace: string })[] = [];
  for (const entry of fs.readdirSync(root)) {
    const m = entry.match(/^\.(.+)\.preview\.json$/);
    if (!m) continue;
    const marker = readPreview(tenant, m[1]);
    if (marker && marker.source === source && fs.existsSync(workspaceDir(tenant, m[1]))) {
      out.push({ ...marker, workspace: m[1] });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** What each branch's last push did, where the Repository page reads it. */
export interface PreviewNote {
  branch: string;
  commit: string;
  subject: string;
  at: string;
  workspace: string;
  applied: boolean;
  issues?: DeployIssue[];
  error?: string;
}

export const previewNotesPath = (tenant: string, scope: string) => path.join(repoDir(tenant, scope), "foldrun-previews.json");

export function readPreviewNotes(tenant: string, scope: string): PreviewNote[] {
  try {
    const notes = JSON.parse(fs.readFileSync(previewNotesPath(tenant, scope), "utf8")) as Record<string, PreviewNote>;
    return Object.values(notes).sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}

function writeNotes(tenant: string, scope: string, notes: Record<string, PreviewNote>) {
  fs.mkdirSync(repoDir(tenant, scope), { recursive: true });
  fs.writeFileSync(previewNotesPath(tenant, scope), JSON.stringify(notes, null, 2));
}

export interface PreviewSync {
  /** Previews deployed from a branch that is new or moved: [workspace, commit]. */
  deployed: { workspace: string; branch: string; commit: string }[];
  /** Previews removed because their branch went. */
  deleted: string[];
}

/**
 * Reconcile previews with a push: every non-main branch that is new or
 * moved is deployed to its preview workspace; every branch that vanished
 * takes its preview with it. Called with the branch list from before the
 * push and after, which is how a plain git-http-backend push, which says
 * nothing about which refs it moved, is read.
 *
 * Deployed with `force`: the in-flight guard protects a workspace's own
 * live runs from being reset under them, and a preview's only runs are the
 * evals this push is about to replace anyway.
 */
export function syncPreviews(tenant: string, source: string, before: RefInfo[], after: RefInfo[]): PreviewSync {
  const was = new Map(before.filter((r) => r.name !== "main").map((r) => [r.name, r.sha]));
  const now = new Map(after.filter((r) => r.name !== "main").map((r) => [r.name, r]));
  const notes: Record<string, PreviewNote> = {};
  for (const n of readPreviewNotes(tenant, source)) notes[n.branch] = n;
  const result: PreviewSync = { deployed: [], deleted: [] };

  for (const [branch, ref] of now) {
    if (was.get(branch) === ref.sha) continue;
    const workspace = previewName(source, branch);
    const at = new Date().toISOString();
    try {
      const files = filesAt(tenant, source, ref.sha);
      const r = deployWorkspace(tenant, workspace, files, { commit: ref.sha, by: "preview", message: `preview of ${branch}`, force: true });
      // The marker only once there is a workspace for it to describe: a
      // refused deploy is recorded in the note, not as a phantom preview.
      if (r.applied) fs.writeFileSync(markerPath(tenant, workspace), JSON.stringify({ source, branch, commit: ref.sha, at } satisfies PreviewMarker));
      notes[branch] = { branch, commit: ref.sha, subject: ref.subject, at, workspace, applied: r.applied, ...(r.issues.length ? { issues: r.issues } : {}) };
      if (r.applied) result.deployed.push({ workspace, branch, commit: ref.sha });
    } catch (err) {
      notes[branch] = { branch, commit: ref.sha, subject: ref.subject, at, workspace, applied: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  for (const branch of was.keys()) {
    if (now.has(branch)) continue;
    const workspace = notes[branch]?.workspace ?? previewName(source, branch);
    try {
      if (fs.existsSync(workspaceDir(tenant, workspace))) deleteWorkspace(tenant, workspace);
      fs.rmSync(markerPath(tenant, workspace), { force: true });
      result.deleted.push(workspace);
    } catch {
      // a preview that would not delete is reported by the next push
    }
    delete notes[branch];
  }

  writeNotes(tenant, source, notes);
  return result;
}

/** A source workspace is going: its previews go with it. */
export function deletePreviewsOf(tenant: string, source: string): string[] {
  const gone: string[] = [];
  for (const p of previewsOf(tenant, source)) {
    try {
      deleteWorkspace(tenant, p.workspace);
      fs.rmSync(markerPath(tenant, p.workspace), { force: true });
      gone.push(p.workspace);
    } catch {
      // best effort; the directory listing is the truth
    }
  }
  return gone;
}
