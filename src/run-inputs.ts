// Inputs on a run (FOL-163, 11 Nov 2026): files a caller hands a run — storage
// paths, as GET …/storage lists them — staged into the step its task reaches,
// at agents/<name>/inputs/<path>. What the run reads is fixed when it is made
// (storage.ts holdRunInputs holds each file's blob for the run), so an
// overwrite or a delete in between changes nothing.
//
// Only an isolated executor stages them — docker (`container`) or one the
// platform says can hold them (platform.holdsInputs: k8s) — and whatever the
// step does inside inputs/ never comes back to the workspace (ApplyOptions
// drop). In-process, a step works in the real folder: two runs of one agent
// would share inputs/, and nothing stands between its writes and the
// workspace, so a run with inputs there is refused before anything starts.
//
// Images and PDFs are shown to the model when it reads them with Read: the
// Agent SDK turns them into image and document blocks, and the translator
// carries those to an OpenAI-format endpoint where it can (translator.ts).

import type { RunInputFile } from "./storage.ts";

export type { RunInputFile };

/** foldrun's limits on what one run may be handed — not a model's. */
export const INPUT_LIMITS = {
  files: 20,
  /** All of them together: 100 MiB. */
  totalBytes: 100 * 1024 * 1024,
} as const;

/** The folder, under the agent's working directory. */
export const INPUTS_DIR = "inputs";

/** Null when `paths` is a list the run routes may take; otherwise why not. */
export function inputsProblem(paths: unknown): string | null {
  if (!Array.isArray(paths)) return "inputs is a list of storage paths";
  if (paths.some((p) => typeof p !== "string" || !p.trim())) return "inputs is a list of storage paths (strings)";
  if (new Set(paths).size > INPUT_LIMITS.files) return `at most ${INPUT_LIMITS.files} inputs on one run`;
  return null;
}

/** Null when the resolved files fit foldrun's limits; otherwise why not. */
export function inputsSizeProblem(files: RunInputFile[]): string | null {
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > INPUT_LIMITS.totalBytes) return `the inputs come to ${(total / 1048576).toFixed(1)} MiB — at most ${INPUT_LIMITS.totalBytes / 1048576} MiB on one run`;
  return null;
}

const human = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${Math.round(n / 1024)} KiB` : `${n} B`);

/** What the step is told, after its instruction. */
export function inputsNote(files: RunInputFile[]): string {
  const lines = files.map((f) => `- ${INPUTS_DIR}/${f.path} (${f.mime}, ${human(f.size)})`);
  return (
    `<inputs>\nThis run was handed ${files.length} file${files.length === 1 ? "" : "s"}, in ${INPUTS_DIR}/ inside your working directory:\n${lines.join("\n")}\n` +
    "Read them with the Read tool. Supported images and PDFs are shown to you as they are; when a model cannot be shown a file, the tool result says so. " +
    `The files stay available to scripts. Anything you write in ${INPUTS_DIR}/ is not kept — put results in outputs/.\n</inputs>`
  );
}

/** The trail's line once they are staged. */
export function stagedLine(files: number, bytes: number): string {
  return `inputs: ${files} file${files === 1 ? "" : "s"} in ${INPUTS_DIR}/ (${human(bytes)})`;
}
