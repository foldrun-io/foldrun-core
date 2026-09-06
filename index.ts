// @foldrun/core — the open-source runtime.
//
// Everything needed to read a workspace of markdown files and run the agents
// in it. No server, no database, no account: point it at a folder.
//
// The hosted platform imports these same modules. That is deliberate — if the
// open version were a reduced copy it would rot, and self-hosting would feel
// like a downgrade instead of a choice. What the platform adds — a queue and
// its worker, metering and billing, pods on a cluster, per-account keys in a
// database, previews, share links, tenancy — lives in its own private package
// and plugs in through platform.ts. Nothing here imports it.

export * from "./src/paths.ts";
export * from "./src/store.ts";
export * from "./src/starter.ts";
export * from "./src/runner.ts";
export * from "./src/okf.ts";
export * from "./src/evals.ts";
export * from "./src/flow-lint.ts";
export * from "./src/catalog.ts";
export * from "./src/model-probe.ts";
export * from "./src/providers.ts";
export * from "./src/translator.ts";
export * from "./src/arrange.ts";
export * from "./src/completions.ts";
export * from "./src/confine.ts";
export * from "./src/platform.ts";
export * from "./src/library.ts";
export * from "./src/tool-programs.ts";
export * from "./src/linkable.ts";
export * from "./src/refs.ts";
export * from "./src/tool-names.ts";
export * from "./src/history.ts";
export * from "./src/gitrepo.ts";
export * from "./src/storage.ts";
export * from "./src/secrets.ts";
export * from "./src/oauth-presets.ts";
export * from "./src/secret-files.ts";
export * from "./src/notify.ts";
export * from "./src/webhook.ts";
export * from "./src/approvals.ts";
export * from "./src/deploy.ts";
export * from "./src/tar.ts";
export * from "./src/git.ts";
