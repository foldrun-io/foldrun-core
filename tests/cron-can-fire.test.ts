// cronCanFire: a cron whose every field is in range but whose day never
// comes round (the 30th of February) is known not to fire without walking
// the calendar for it. 30 Oct 2026.
import test from "node:test";
import assert from "node:assert/strict";
import { cronCanFire, parseCron } from "../src/cron.ts";

const can = (expr: string) => cronCanFire(parseCron(expr)!);

test("a day no month in the cron has is impossible", () => {
  assert.equal(can("0 0 30 2 *"), false);
  assert.equal(can("0 0 31 2,4,6,9,11 *"), false);
  assert.equal(can("0 0 30,31 feb *"), false);
});

test("anything the calendar can reach is possible", () => {
  assert.equal(can("0 0 29 2 *"), true, "every fourth year");
  assert.equal(can("0 0 31 1-2 *"), true, "January has a 31st");
  assert.equal(can("0 0 30,1 2 *"), true, "the 1st of February is enough");
  assert.equal(can("0 9 * * 1"), true);
  assert.equal(can("@daily"), true);
  assert.equal(can("0 0 30 2 mon"), true, "with a weekday either matches, and February has Mondays");
});
