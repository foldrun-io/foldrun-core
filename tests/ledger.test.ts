// The money ledger: append-only lines whose sum is the balance.
//
//   node --test tests/ledger.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readLedger,
  creditBalance,
  recordTopUp,
  recordRunCost,
  assertFunds,
  priceRun,
  ledgerSummary,
  noteRunDeleted,
  accrueDaily,
} from "../packages/core/src/ledger.ts";
import { accountUsage } from "../packages/core/src/usage.ts";

async function withAccount(body: () => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-ledger-"));
  const prevData = process.env.FOLDRUN_DATA;
  const prevBilling = process.env.FOLDRUN_BILLING;
  const priceVars = [
    "FOLDRUN_MARGIN",
    "FOLDRUN_MIN_RUN_FEE",
    "FOLDRUN_RUN_FEE",
    "FOLDRUN_NET_USD_PER_GB",
    "FOLDRUN_COMPUTE_USD_PER_SEC",
    "FOLDRUN_COMPUTE_USD_PER_CORE_SEC",
    "FOLDRUN_COMPUTE_USD_PER_GIB_SEC",
    "FOLDRUN_CPU_USD_PER_BUSY_SEC",
    "FOLDRUN_MAX_RUN_EXPOSURE",
  ];
  const prevPrices = priceVars.map((k) => [k, process.env[k]] as const);
  for (const k of priceVars) delete process.env[k];
  process.env.FOLDRUN_DATA = root;
  try {
    fs.mkdirSync(path.join(root, "acme/workspaces"), { recursive: true });
    await body();
  } finally {
    if (prevData === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prevData;
    if (prevBilling === undefined) delete process.env.FOLDRUN_BILLING;
    else process.env.FOLDRUN_BILLING = prevBilling;
    for (const [k, v] of prevPrices) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a balance is the sum of its lines", async () => {
  await withAccount(async () => {
    assert.equal(await creditBalance("acme"), 0);
    await recordTopUp("acme", 10);
    await recordRunCost("acme", "desk", "run-a", 0.25);
    await recordRunCost("acme", "desk", "run-b", 0.5);
    assert.equal(await creditBalance("acme"), 9.25);
    assert.equal((await readLedger("acme")).length, 3);
  });
});

test("a run is billed once, however many times it is settled", async () => {
  await withAccount(async () => {
    await recordTopUp("acme", 5);
    assert.ok(await recordRunCost("acme", "desk", "run-a", 1));
    assert.equal(await recordRunCost("acme", "desk", "run-a", 1), null);
    assert.equal(await creditBalance("acme"), 4);
  });
});

test("a free run writes nothing", async () => {
  await withAccount(async () => {
    assert.equal(await recordRunCost("acme", "desk", "run-a", 0), null);
    assert.equal((await readLedger("acme")).length, 0);
  });
});

test("enforcement is opt-in, and refuses with a 402", async () => {
  await withAccount(async () => {
    delete process.env.FOLDRUN_BILLING;
    await assertFunds("acme"); // never throws when the install doesn't enforce

    process.env.FOLDRUN_BILLING = "1";
    let threw: unknown = null;
    try {
      await assertFunds("acme");
    } catch (err) {
      threw = err;
    }
    assert.ok(threw instanceof Error, "an empty tank refuses");
    assert.equal((threw as Error & { status?: number }).status, 402);

    await recordTopUp("acme", 1);
    await assertFunds("acme"); // funded accounts pass
  });
});

test("a torn tail line loses one entry, never the file", async () => {
  await withAccount(async () => {
    await recordTopUp("acme", 10);
    const file = path.join(process.env.FOLDRUN_DATA!, "acme/ledger.jsonl");
    fs.appendFileSync(file, '{"t":"2026-08-24T00:00:00.000Z","kind":"run","usd":-1'); // no close, no newline
    assert.equal((await readLedger("acme")).length, 1);
    assert.equal(await creditBalance("acme"), 10);
  });
});

// ------------------------------------------------------------------ margin

test("no margin configured means charge equals cost — the self-hoster default", async () => {
  assert.equal(priceRun(0.5), 0.5);
  assert.equal(priceRun(0), 0);
});

test("margin marks up, the floor catches the tail, and both round to micro-dollars", async () => {
  process.env.FOLDRUN_MARGIN = "1.25";
  process.env.FOLDRUN_MIN_RUN_FEE = "0.01";
  try {
    assert.equal(priceRun(1), 1.25);
    assert.equal(priceRun(0.001), 0.01); // the floor, not 0.00125
    assert.equal(priceRun(0.1), 0.125);
    // a run that spent nothing is charged nothing — the floor never
    // invents a bill for a run our own gate refused
    assert.equal(priceRun(0), 0);
    assert.equal(priceRun(1 / 3), 0.416667); // micro-dollar rounding
  } finally {
    delete process.env.FOLDRUN_MARGIN;
    delete process.env.FOLDRUN_MIN_RUN_FEE;
  }
});

test("a charged run carries its provider cost, and the summary derives the margin", async () => {
  await withAccount(async () => {
    process.env.FOLDRUN_MARGIN = "1.5";
    await recordTopUp("acme", 10);
    await recordRunCost("acme", "desk", "run-a", 2); // charged 3, cost 2
    const [, run] = await readLedger("acme");
    assert.equal(run.usd, -3);
    assert.equal(run.cost, 2);
    const s = await ledgerSummary("acme");
    assert.equal(s.balanceUsd, 7);
    assert.equal(s.chargedUsd, 3);
    assert.equal(s.providerCostUsd, 2);
    assert.equal(s.marginUsd, 1);
  });
});

test("pre-margin entries count as charge == cost in the summary", async () => {
  await withAccount(async () => {
    await recordTopUp("acme", 10);
    // an old-format line, written by hand the way the old code wrote it
    const fs2 = fs;
    const file = path.join(process.env.FOLDRUN_DATA!, "acme", "ledger.jsonl");
    fs2.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), kind: "run", usd: -1, workspace: "desk", runId: "run-old" }) + "\n");
    const s = await ledgerSummary("acme");
    assert.equal(s.chargedUsd, 1);
    assert.equal(s.providerCostUsd, 1);
    assert.equal(s.marginUsd, 0);
  });
});

// ------------------------------------------------- runs, steps and compute

test("with nothing configured, a BYOK run is free — the self-hoster default", async () => {
  // Their key bought the tokens, so tokenCostUsd is 0. Nothing is charged
  // until an operator decides what a run and a sandbox second are worth.
  assert.equal(priceRun({ tokenCostUsd: 0, steps: 4, computeSecs: 120 }), 0);
});

test("a BYOK run bills compute and network — never tokens, never steps", async () => {
  process.env.FOLDRUN_RUN_FEE = "0.02";
  process.env.FOLDRUN_COMPUTE_USD_PER_SEC = "0.0001";
  process.env.FOLDRUN_NET_USD_PER_GB = "0.10";
  process.env.FOLDRUN_MARGIN = "1.25";
  try {
    // 0.02 + 120×0.0001 + 0.5GB×0.10 = 0.082. No step fee by design — a
    // step is not a unit the platform pays for, and charging one would
    // punish well-factored flows. No margin: their key bought the tokens.
    assert.equal(
      priceRun({ tokenCostUsd: 0, steps: 4, computeSecs: 120, netBytes: 0.5 * 1024 ** 3 }),
      0.082,
    );
  } finally {
    for (const k of ["FOLDRUN_RUN_FEE", "FOLDRUN_NET_USD_PER_GB", "FOLDRUN_COMPUTE_USD_PER_SEC", "FOLDRUN_MARGIN"]) {
      delete process.env[k];
    }
  }
});

test("models-included stacks the margin on top of the same meters", async () => {
  process.env.FOLDRUN_RUN_FEE = "0.02";
  process.env.FOLDRUN_COMPUTE_USD_PER_SEC = "0.0001";
  process.env.FOLDRUN_MARGIN = "1.25";
  try {
    // 1×1.25 + 0.02 + 120×0.0001
    assert.equal(priceRun({ tokenCostUsd: 1, steps: 4, computeSecs: 120 }), 1.282);
  } finally {
    for (const k of ["FOLDRUN_RUN_FEE", "FOLDRUN_COMPUTE_USD_PER_SEC", "FOLDRUN_MARGIN"]) {
      delete process.env[k];
    }
  }
});

test("a run that did nothing is free however the fees are set", async () => {
  process.env.FOLDRUN_RUN_FEE = "0.02";
  process.env.FOLDRUN_MIN_RUN_FEE = "0.01";
  try {
    // No tokens, no steps, no seconds: our own gate refused it before it
    // started, and the per-run fee must not invent a bill for that.
    assert.equal(priceRun({ tokenCostUsd: 0, steps: 0, computeSecs: 0 }), 0);
  } finally {
    delete process.env.FOLDRUN_RUN_FEE;
    delete process.env.FOLDRUN_MIN_RUN_FEE;
  }
});

test("a BYOK line records zero provider cost, so the margin is the whole charge", async () => {
  await withAccount(async () => {
    process.env.FOLDRUN_COMPUTE_USD_PER_SEC = "0.001";
    try {
      await recordTopUp("acme", 10);
      await recordRunCost("acme", "desk", "run-a", { tokenCostUsd: 0, steps: 3, computeSecs: 30 });
      const [, run] = await readLedger("acme");
      assert.equal(run.usd, -0.03);
      assert.equal(run.cost, 0);
      assert.deepEqual(run.meter, { steps: 3, computeSecs: 30 });

      const s = await ledgerSummary("acme");
      assert.equal(s.chargedUsd, 0.03);
      assert.equal(s.providerCostUsd, 0); // we bought no tokens
      assert.equal(s.marginUsd, 0.03); // so all of it is margin
    } finally {
      delete process.env.FOLDRUN_COMPUTE_USD_PER_SEC;
    }
  });
});

test("a day accrues the base fee and storage once, however often it is swept", async () => {
  await withAccount(async () => {
    process.env.FOLDRUN_BILLING = "1";
    process.env.FOLDRUN_BASE_FEE_MONTHLY = "30";
    process.env.FOLDRUN_STORAGE_USD_PER_GB_MONTH = "0.15";
    try {
      const day = new Date("2026-09-15T08:00:00.000Z"); // September: 30 days
      const first = await accrueDaily("acme", 2 * 1024 ** 3, day);
      assert.equal(first.length, 2);
      assert.equal(first[0].usd, -1); // 30 / 30 days
      assert.equal(first[1].usd, -0.01); // 2GB × 0.15 / 30
      // Swept again the same day: nothing doubles.
      assert.equal((await accrueDaily("acme", 2 * 1024 ** 3, day)).length, 0);
      // A new day accrues again.
      assert.equal((await accrueDaily("acme", 2 * 1024 ** 3, new Date("2026-09-16T08:00:00.000Z"))).length, 2);
    } finally {
      delete process.env.FOLDRUN_BASE_FEE_MONTHLY;
      delete process.env.FOLDRUN_STORAGE_USD_PER_GB_MONTH;
    }
  });
});

test("a run priced at zero writes no line, however many steps it ran", async () => {
  await withAccount(async () => {
    // Self-host, no pricing configured, BYOK: nothing to charge and nothing
    // to observe, so the ledger stays empty rather than filling with $0.
    assert.equal(await recordRunCost("acme", "desk", "run-a", { tokenCostUsd: 0, steps: 9, computeSecs: 300 }), null);
    assert.equal((await readLedger("acme")).length, 0);
  });
});

// --------------------------------------------------- the two billing races

test("two racing settles cannot bill a run twice, even with the ledger scan blinded", async () => {
  await withAccount(async () => {
    await recordTopUp("acme", 10);
    // The scan-then-append window: both drivers read a ledger with no line
    // for this run. The marker claim is what must hold — simulate the loser
    // arriving after the winner's marker but as if its scan saw nothing, by
    // simply calling again (the marker, not the scan, is the guarantee).
    assert.ok(await recordRunCost("acme", "desk", "run-a", 1));
    // Delete the ledger line, keep the marker: the scan now says "not
    // billed", and only the marker stands between this and a double charge.
    const file = path.join(process.env.FOLDRUN_DATA!, "acme/ledger.jsonl");
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    fs.writeFileSync(file, lines.filter((l) => !l.includes("run-a")).join("\n") + "\n");
    assert.equal(await recordRunCost("acme", "desk", "run-a", 1), null);
  });
});

test("runs billed before markers existed are not re-billed after the upgrade", async () => {
  await withAccount(async () => {
    await recordTopUp("acme", 10);
    // A pre-marker line: written directly, no marker file beside it.
    const file = path.join(process.env.FOLDRUN_DATA!, "acme/ledger.jsonl");
    fs.appendFileSync(
      file,
      JSON.stringify({ t: "2026-01-01T00:00:00.000Z", kind: "run", usd: -1, workspace: "desk", runId: "run-old" }) + "\n",
    );
    assert.equal(await recordRunCost("acme", "desk", "run-old", 1), null);
    assert.equal(await creditBalance("acme"), 9);
  });
});

test("exposure holds the balance for every unsettled run", async () => {
  await withAccount(async () => {
    process.env.FOLDRUN_BILLING = "1";
    process.env.FOLDRUN_MAX_RUN_EXPOSURE = "2";
    await recordTopUp("acme", 5);

    await assertFunds("acme", 0); // $5 covers one $2 hold
    await assertFunds("acme", 1); // and two
    let threw: unknown = null;
    try {
      await assertFunds("acme", 2); // a third would need $6 held against $5
    } catch (err) {
      threw = err;
    }
    assert.ok(threw instanceof Error, "the burst is refused, not admitted");
    assert.equal((threw as Error & { status?: number }).status, 402);
    assert.match((threw as Error).message, /held/);
  });
});

test("without an exposure ceiling the gate keeps its old shape: positive admits", async () => {
  await withAccount(async () => {
    process.env.FOLDRUN_BILLING = "1";
    await recordTopUp("acme", 0.01);
    await assertFunds("acme", 50); // in-flight count is ignored when no ceiling is set
  });
});

// ------------------------------------------------------ deletion and money

test("deleting a charged run explains itself in the ledger and moves nothing", async () => {
  await withAccount(async () => {
    await recordTopUp("acme", 10);
    await recordRunCost("acme", "desk", "run-a", 2);
    const before = await creditBalance("acme");

    await noteRunDeleted("acme", "desk", "run-a");
    const entries = await readLedger("acme");
    const note = entries[entries.length - 1];
    assert.equal(note.kind, "adjustment");
    assert.equal(note.usd, 0);
    assert.equal(note.runId, "run-a");
    assert.match(note.note!, /charge stands/);
    // The story is completed; the money is untouched.
    assert.equal(await creditBalance("acme"), before);
  });
});

test("deleting an unbilled run leaves no ledger residue", async () => {
  await withAccount(async () => {
    await recordTopUp("acme", 10);
    await noteRunDeleted("acme", "desk", "run-never-billed");
    assert.equal((await readLedger("acme")).length, 1); // just the top-up
  });
});

// ------------------------------------------------------------- usage report

test("the usage report cuts one set of facts three ways that agree", async () => {
  await withAccount(async () => {
    process.env.FOLDRUN_RUNNER_CPUS = "2";
    process.env.FOLDRUN_RUNNER_MEMORY = "4Gi";
    try {
      const ws = path.join(process.env.FOLDRUN_DATA!, "acme/workspaces/desk");
      fs.mkdirSync(path.join(ws, "runs"), { recursive: true });
      fs.writeFileSync(path.join(ws, "AGENTS.md"), "---\nname: desk\n---\n");
      fs.writeFileSync(
        path.join(ws, "runs/run-a.json"),
        JSON.stringify({
          id: "run-a", flow: "publish", status: "completed",
          startedAt: "2026-08-26T00:00:00.000Z", finishedAt: "2026-08-26T00:05:00.000Z",
          steps: [
            { agent: "writer", instruction: "", group: 1, optional: false, status: "completed",
              events: [], result: "x", costUsd: 0.5, computeSecs: 30,
              tokens: { input: 1000, output: 400 } },
            { agent: "editor", instruction: "", group: 2, optional: false, status: "completed",
              events: [], result: "y", costUsd: 0.25, computeSecs: 10,
              tokens: { input: 500, output: 100 } },
            // A carried step ran — and was counted — in another run.
            { agent: "writer", instruction: "", group: 3, optional: false, status: "completed",
              events: [], result: "z", costUsd: null, computeSecs: null, carriedFrom: "run-0" },
          ],
        }),
      );

      const u = await accountUsage("acme");
      assert.equal(u.totals.runs, 1);
      assert.equal(u.totals.steps, 2, "the carried step is not consumption");
      assert.equal(u.totals.tokenCostUsd, 0.75);
      assert.equal(u.totals.inputTokens, 1500);
      assert.equal(u.totals.computeSecs, 40);
      // Reservations: computeSecs × the limits in force.
      assert.equal(u.totals.cpuSecs, 80);
      assert.equal(u.totals.gibSecs, 160);

      const desk = u.workspaces.find((w) => w.workspace === "desk")!;
      // The flow cut and the agent cut are the same facts sliced twice.
      assert.equal(desk.byFlow.publish.tokenCostUsd, 0.75);
      assert.equal(desk.byAgent.writer.tokenCostUsd, 0.5);
      assert.equal(desk.byAgent.editor.tokenCostUsd, 0.25);
      assert.equal(
        Object.values(desk.byAgent).reduce((s, b) => s + b.computeSecs, 0),
        desk.computeSecs,
      );
      // Storage sees the files just written.
      assert.ok(desk.storage.runsBytes > 0);
      assert.ok(desk.storage.sourceBytes > 0);
    } finally {
      delete process.env.FOLDRUN_RUNNER_CPUS;
      delete process.env.FOLDRUN_RUNNER_MEMORY;
    }
  });
});

test("compute bills in whole seconds with a one-second floor", async () => {
  process.env.FOLDRUN_COMPUTE_USD_PER_SEC = "0.01";
  try {
    assert.equal(priceRun({ tokenCostUsd: 0, steps: 1, computeSecs: 0.4 }), 0.01); // floor
    assert.equal(priceRun({ tokenCostUsd: 0, steps: 1, computeSecs: 10.2 }), 0.11); // ceil
    // Zero compute is zero — the floor never invents a bill.
    assert.equal(priceRun({ tokenCostUsd: 0, steps: 0, computeSecs: 0 }), 0);
  } finally {
    delete process.env.FOLDRUN_COMPUTE_USD_PER_SEC;
  }
});

test("hold plus work: reserved slices and burned CPU each carry a price", async () => {
  process.env.FOLDRUN_COMPUTE_USD_PER_CORE_SEC = "0.00003";
  process.env.FOLDRUN_COMPUTE_USD_PER_GIB_SEC = "0.000004";
  process.env.FOLDRUN_CPU_USD_PER_BUSY_SEC = "0.0001";
  try {
    // A browser-ish step: 60s holding 3 cores / 6 GiB, 45 CPU-seconds burned.
    // hold: 180 core·s × 0.00003 + 360 GiB·s × 0.000004 = 0.00684
    // work: 45 × 0.0001 = 0.0045
    const busy = priceRun({
      tokenCostUsd: 0, steps: 1, computeSecs: 60,
      compute: { coreSecs: 180, gibSecs: 360, busyCpuSecs: 45, flatSecs: 0 },
    });
    assert.equal(busy, 0.01134);
    // The same 60 seconds idle on a small slice: 60 core·s + 60 GiB·s, no burn.
    // The idle small pod pays a fraction of the busy large one — both facts
    // (held less, worked less) lower the bill, which is the fairness asked for.
    const idle = priceRun({
      tokenCostUsd: 0, steps: 1, computeSecs: 60,
      compute: { coreSecs: 60, gibSecs: 60, busyCpuSecs: 0, flatSecs: 0 },
    });
    assert.equal(idle, 0.01134 - 0.00684 - 0.0045 + 0.00204);
    // An unreadable work meter bills hold only — a bill never guesses.
    assert.ok(idle < busy / 2);
  } finally {
    for (const k of ["FOLDRUN_COMPUTE_USD_PER_CORE_SEC", "FOLDRUN_COMPUTE_USD_PER_GIB_SEC", "FOLDRUN_CPU_USD_PER_BUSY_SEC"]) {
      delete process.env[k];
    }
  }
});

test("steps recorded before reservations were facts bill at the flat rate", async () => {
  process.env.FOLDRUN_COMPUTE_USD_PER_SEC = "0.01";
  process.env.FOLDRUN_COMPUTE_USD_PER_CORE_SEC = "0.001";
  try {
    // Mixed run: one modern step (10 core·s) and one pre-reservation step
    // (5 plain seconds). Each is priced by the meter that exists for it.
    assert.equal(
      priceRun({
        tokenCostUsd: 0, steps: 2, computeSecs: 15,
        compute: { coreSecs: 10, gibSecs: 0, busyCpuSecs: 0, flatSecs: 5 },
      }),
      0.06, // 10×0.001 + 5×0.01
    );
  } finally {
    delete process.env.FOLDRUN_COMPUTE_USD_PER_SEC;
    delete process.env.FOLDRUN_COMPUTE_USD_PER_CORE_SEC;
  }
});
