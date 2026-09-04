// The arithmetic every paged list in the dashboard shares. Ten a page; an
// out-of-range page clamps rather than rendering nothing; a bad param is
// page one.

import test from "node:test";
import assert from "node:assert/strict";
import { paginate, pageFrom, PAGE_SIZE } from "../web/components/paging.ts";

test("ten a page, clamped at both ends, with the total kept", () => {
  const items = Array.from({ length: 23 }, (_, i) => i);
  assert.equal(PAGE_SIZE, 10);
  assert.deepEqual(paginate(items, 1), { rows: items.slice(0, 10), pages: 3, page: 1, total: 23 });
  assert.deepEqual(paginate(items, 3).rows, [20, 21, 22]);
  // Past the end — a delete emptied the last page — lands on the last page.
  assert.equal(paginate(items, 9).page, 3);
  assert.equal(paginate(items, 0).page, 1);
  assert.equal(paginate(items, -4).page, 1);
  // Empty lists still have one page, so a pager never says "page 1 of 0".
  assert.deepEqual(paginate([], 1), { rows: [], pages: 1, page: 1, total: 0 });
  // A custom size still clamps.
  assert.equal(paginate(items, 2, 5).rows[0], 5);
});

test("the ?page= param reads as a whole number, one when it is not", () => {
  assert.equal(pageFrom("3"), 3);
  assert.equal(pageFrom("2.9"), 2);
  assert.equal(pageFrom(["4", "9"]), 4);
  assert.equal(pageFrom(undefined), 1);
  assert.equal(pageFrom("0"), 1);
  assert.equal(pageFrom("-2"), 1);
  assert.equal(pageFrom("last"), 1);
});
