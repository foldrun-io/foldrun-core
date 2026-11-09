// An in-memory RecordsPort — the reference the contract suite is first run
// against, so the suite is known to describe the port and not Postgres.

import type { RecordsPort } from "../src/records.ts";
import type { RunRecord, RunSummary } from "../src/store.ts";
import type { TriggerEvent } from "../src/trigger-log.ts";
import type { FileRecord } from "../src/storage.ts";

interface Row {
  run: RunRecord;
  summary: RunSummary;
  live: boolean;
  stamp: number;
}

export function fakeRecords(): RecordsPort & { fenced: string[] } {
  const runs = new Map<string, Row>(); // tenant\0ws\0id
  const triggers = new Map<string, TriggerEvent[]>();
  const files = new Map<string, Map<string, FileRecord>>();
  const locks = new Map<string, Promise<unknown>>();
  let tick = 0; // two writes in one microsecond still differ
  const k = (t: string, w: string, id = "") => `${t}\0${w}\0${id}`;
  const inWs = (t: string, w: string) => [...runs.entries()].filter(([key]) => key.startsWith(k(t, w))).map(([, r]) => r);
  const newest = (a: Row, b: Row) => b.run.startedAt.localeCompare(a.run.startedAt) || b.run.id.localeCompare(a.run.id);
  const move = <V>(m: Map<string, V>, t: string, from: string, to: string) => {
    for (const key of [...m.keys()]) {
      if (!key.startsWith(k(t, from))) continue;
      m.set(key.replace(k(t, from), k(t, to)), m.get(key)!);
      m.delete(key);
    }
  };
  const fenced: string[] = [];
  const syncPort = {
    runGet: (t: string, w: string, id: string) => (runs.has(k(t, w, id)) ? structuredClone(runs.get(k(t, w, id))!.run) : null),
    runSummaries: (t: string, w: string) => inWs(t, w).sort(newest).map((r) => structuredClone(r.summary)),
    runLive: (t: string, w: string) => inWs(t, w).filter((r) => r.live).sort(newest).map((r) => structuredClone(r.run)),
  };
  return {
    fenced,
    async: {
      runGet: async (t, w, id) => syncPort.runGet(t, w, id),
      runSummaries: async (t, w) => syncPort.runSummaries(t, w),
      runLive: async (t, w) => syncPort.runLive(t, w),
      runPut: async (t, w, run, summary, live) => void runs.set(k(t, w, run.id), { run: structuredClone(run), summary: structuredClone(summary), live, stamp: Date.now() * 1000 + tick++ }),
    },
    runPut: (t, w, run, summary, live) => void runs.set(k(t, w, run.id), { run: structuredClone(run), summary: structuredClone(summary), live, stamp: Date.now() * 1000 + tick++ }),
    runGet: (t, w, id) => (runs.has(k(t, w, id)) ? structuredClone(runs.get(k(t, w, id))!.run) : null),
    runDelete: (t, w, id) => runs.delete(k(t, w, id)),
    runSummaries: (t, w) => inWs(t, w).sort(newest).map((r) => structuredClone(r.summary)),
    runLive: (t, w) => inWs(t, w).filter((r) => r.live).sort(newest).map((r) => structuredClone(r.run)),
    runCount: (t, w) => inWs(t, w).length,
    runCounts(t) {
      const out: Record<string, number> = {};
      for (const key of runs.keys()) {
        const [tenant, ws] = key.split("\0");
        if (tenant === t) out[ws] = (out[ws] ?? 0) + 1;
      }
      return out;
    },
    runAll: (t, w) => inWs(t, w).sort(newest).map((r) => structuredClone(r.run)),
    runRecent: (t, w, flow, limit) => inWs(t, w).filter((r) => r.run.flow === flow).sort(newest).slice(0, limit).map((r) => structuredClone(r.run)),
    runsSince: (t, w, ms) => inWs(t, w).filter((r) => Date.parse(r.run.startedAt) >= ms).sort(newest).map((r) => structuredClone(r.run)),
    runStamp: (t, w, id) => runs.get(k(t, w, id))?.stamp ?? null,
    triggerAppend(t, w, e) {
      const l = triggers.get(k(t, w)) ?? [];
      l.push(structuredClone(e));
      triggers.set(k(t, w), l.slice(-500));
    },
    triggerRead: (t, w, limit) => (triggers.get(k(t, w)) ?? []).slice(-limit).reverse(),
    fileList: (t, w) => [...(files.get(k(t, w))?.values() ?? [])].map((f) => ({ ...f })),
    filePut(t, w, f) {
      const m = files.get(k(t, w)) ?? new Map();
      m.set(f.path, { ...f });
      files.set(k(t, w), m);
    },
    fileDelete: (t, w, p) => files.get(k(t, w))?.delete(p) ?? false,
    workspaceDrop(t, w) {
      for (const key of [...runs.keys()]) if (key.startsWith(k(t, w))) runs.delete(key);
      triggers.delete(k(t, w));
      files.delete(k(t, w));
    },
    workspaceMove(t, from, to) {
      move(runs, t, from, to);
      move(triggers, t, from, to);
    },
    fileMove(t, from, to) {
      move(files, t, from, to);
    },
    async lock(name, fn) {
      const prev = locks.get(name) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(() => {
        fenced.push(name);
        return fn();
      });
      locks.set(name, run);
      try {
        return await run;
      } finally {
        if (locks.get(name) === run) locks.delete(name);
      }
    },
  };
}
