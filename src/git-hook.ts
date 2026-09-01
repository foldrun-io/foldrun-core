// The pre-receive check, run by git inside a push.
//
// git feeds "<old> <new> <ref>" lines on stdin. For a push to main, read the
// tree at the new commit straight from the object store and run the deploy
// checks on it. Any issue: print them and exit non-zero — the push is refused
// and the person sees exactly what a dashboard deploy would have told them,
// in their terminal, before anything changed.
//
// Runs as its own process under git's environment. GIT_DIR is set by git.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { deployIssues } from "./deploy.ts";

const dir = process.env.GIT_DIR;
if (!dir) process.exit(0);

// `_library.git` is the account shelf, not a workspace: it holds tools,
// skills and knowledge and has no agents by definition. The workspace rules
// refused every push to it with "no agents". Its sync (syncLibraryFromTree)
// validates what it accepts on receive; nothing here to add yet.
if (path.basename(dir.replace(/\/+$/, "")) === "_library.git") process.exit(0);

const input = fs.readFileSync(0, "utf8");
const git = (args: string[]) => {
  const r = spawnSync("git", ["--git-dir", dir, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.toString() : null;
};

let refused = false;
for (const line of input.split("\n").filter(Boolean)) {
  const [, newSha, ref] = line.split(" ");
  if (ref !== "refs/heads/main" || /^0+$/.test(newSha)) continue;
  const tree = git(["ls-tree", "-r", "--name-only", newSha]) ?? "";
  const files = tree
    .split("\n")
    .filter(Boolean)
    .flatMap((p) => {
      const content = git(["show", `${newSha}:${p}`]);
      return content === null ? [] : [{ path: p, content }];
    });
  const issues = deployIssues(files);
  if (issues.length) {
    refused = true;
    process.stderr.write(`\nfoldrun: refusing this push — ${issues.length} problem${issues.length === 1 ? "" : "s"} the checks would have stopped at deploy:\n`);
    for (const i of issues) process.stderr.write(`  ${i.where}: ${i.message}\n`);
    process.stderr.write(`\nFix and push again. (foldrun check runs the same rules locally.)\n\n`);
  }
}
process.exit(refused ? 1 : 0);
