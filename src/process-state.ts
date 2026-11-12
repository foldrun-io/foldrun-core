// State that must be ONE per process, not one per copy of a module.
//
// A bundler that compiles the boot file and the route handlers apart (Next
// does) gives each bundle its own copy of every module they share. A
// registration made at boot — "revisions go to this store", "the vault is in
// the database" — then fills the boot bundle's copy, and a route handler reads
// its own, still empty: on dev (12 Nov 2026) a dashboard save was never
// journalled as a revision, and a run's outputs published to the object store
// answered "no such output" from the API, because only the worker (one bundle)
// saw the stores. platform.ts met this first, for its hooks.
//
// globalThis is the one thing every bundle in a process shares; a module keeps
// what it is told at boot (and the queues that go with it) in an object made
// here once.

/** The process's one object under `name`, made by `init` the first time. */
export function processState<T extends object>(name: string, init: () => T): T {
  const g = globalThis as unknown as Record<symbol, object | undefined>;
  const key = Symbol.for(`foldrun.state.${name}`);
  return (g[key] ??= init()) as T;
}
