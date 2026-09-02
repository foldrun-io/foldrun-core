// Does a script tool's `run:` actually point at a program?
//
// The failure this exists for is the quietest one the format has. A script
// tool whose `run:` resolves to nothing does not raise an error at load: the
// definition parses, the tool is counted, the agent is told it has the
// capability — and then the call fails inside a turn as a tool error the
// model paraphrases into something plausible. `foldrun check` counted such a
// tool among the workspace's tools and printed "no problems", which is the
// one report that makes a typo invisible.
//
// The resolution here is the runtime's, not a second copy of it. That matters
// more than it looks: `run:` has six accepted spellings across three scopes,
// and a checker that reimplemented them would eventually disagree with the
// runner — passing a tool that cannot run, or failing one that can.

import fs from "node:fs";
import path from "node:path";

import { workspaceDir, workspaceTools, type ToolDef } from "./store.ts";
import { libraryDir, libraryTools } from "./library.ts";
import { resolveRunPath } from "./script-tools.ts";

export interface MissingProgram {
  /** The tool's name, as an agent would write it in `tools:`. */
  name: string;
  /** Which shelf it came off — the two resolve differently. */
  scope: "workspace" | "account";
  /** The `run:` as the definition spells it, after folder qualification. */
  run: string;
  /** The absolute path that was looked for, so the message can be acted on. */
  looked: string;
}

/**
 * Every script tool an agent here could call whose program is not on disk.
 *
 * Both shelves, because a grant reaches both and the runtime resolves
 * nearest-wins across them — a checker that only read the workspace would
 * call a working account tool broken.
 */
export function missingToolPrograms(tenant: string, workspace: string): MissingProgram[] {
  const dir = workspaceDir(tenant, workspace);
  // Tools are workspace- or account-scoped, so resolve as if from an agent
  // directory one level down — the same base the runtime and the tool tester
  // both use.
  const from = path.join(dir, "agents", "_probe");
  const libScripts = libraryDir(tenant, "scripts");

  const out: MissingProgram[] = [];
  const scan = (defs: Record<string, ToolDef>, scope: "workspace" | "account") => {
    for (const [name, def] of Object.entries(defs)) {
      if (def.kind !== "script") continue;
      const run = String((def.spec as { run?: unknown }).run ?? "");
      // A single-file tool carries its program in the body and has no path to
      // resolve. It is a shape we still accept, not a missing program.
      if (!run) continue;
      const looked = resolveRunPath(from, run, libScripts);
      if (!fs.existsSync(looked)) out.push({ name, scope, run, looked });
    }
  };

  scan(libraryTools(tenant), "account");
  scan(workspaceTools(tenant, workspace), "workspace");
  return out;
}
