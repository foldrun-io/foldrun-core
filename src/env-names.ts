// Environment names that steer what a program loads or runs rather than
// carry data (FOL-130). One list, read twice:
//
// - run-container.ts strips them from a run container's root shell before
//   anything runs as root (ROOT_SHELL_GUARD_SH) — that shell's environment is
//   the platform's own (the image's, the pod spec's), so this is a second
//   lock, not the boundary: the step's environment never reaches root at all.
// - scan.ts warns when a `secrets:` entry is named after one of them
//   (secret/reserved-env-name): a secret is exported to the sandbox under its
//   own name, so a secret called LD_PRELOAD or PATH re-points every program
//   the agent runs, which is almost never what its author meant.
//
// Pure data, no imports: both the shell snippet and the scanner load it.

/** Names that tell the dynamic loader, a shell or a language runtime what to
 *  load or run before the program's own code: prefixes end in `*`. */
export const LOADER_ENV: readonly string[] = [
  "LD_*",
  "GCONV_PATH",
  "GLIBC_TUNABLES",
  "BASH_ENV",
  "ENV",
  "CDPATH",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "RUBYOPT",
  "RUBYLIB",
];

/** Names every shell and program reads for where to look and who it is.
 *  The root shell keeps the image's values of these; a secret named after
 *  one still replaces it for every program the agent runs. */
export const SHELL_ENV: readonly string[] = ["PATH", "IFS", "HOME", "SHELL", "USER", "LOGNAME", "PWD"];

/** Names that say where a program's traffic goes: the egress proxy's, which
 *  the platform sets from the step's lease (FOL-215). A secret named after one
 *  would replace the proxy for every program, so the runner exports it under
 *  the declared-secret prefix instead. */
export const PROXY_ENV: readonly string[] = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_USE_ENV_PROXY", "FOLDRUN_EGRESS*"];

/** Is this a name the platform sets for the step's egress? */
export const isProxyEnvName = (name: string): boolean => matches(name, PROXY_ENV);

/** LOADER_ENV as the arms of a shell `case` (`LD_*|GCONV_PATH|…`). */
export const LOADER_ENV_CASE = LOADER_ENV.join("|");

const matches = (name: string, list: readonly string[]) =>
  list.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));

/** Why an environment name is not one to give a secret, or null when it is
 *  an ordinary name. */
export function reservedEnvName(name: string): string | null {
  if (matches(name, LOADER_ENV)) return "it tells the loader, the shell or a language runtime what to load into every program the agent starts";
  if (matches(name, SHELL_ENV)) return "every shell and program in the sandbox reads it, and the secret's value replaces the sandbox's own";
  if (matches(name, PROXY_ENV)) return "the platform sets it to the step's egress proxy, so the secret is exported as FOLDRUN_DECLARED_" + name + " instead";
  return null;
}
