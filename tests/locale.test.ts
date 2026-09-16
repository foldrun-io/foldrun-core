import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRegion, regionProblem, resolveRegion, deriveLocale, localeProblems, localeProse, regionName } from "../src/locale.ts";

const D = new Date("2026-09-17T00:00:00Z");

test("a region is two letters, upper-cased; anything else is not one", () => {
  assert.equal(normalizeRegion("au"), "AU");
  assert.equal(normalizeRegion(" ir "), "IR");
  assert.equal(normalizeRegion("AUS"), null);
  assert.equal(normalizeRegion("Australia"), null);
  assert.match(regionProblem("Australia")!, /not a country code/);
  assert.equal(regionProblem(undefined), null);
});

test("the region cascade: levels, then env, then the language tag, then none", () => {
  assert.deepEqual(resolveRegion([{ level: "agent", value: "ir" }], "fa", {}), { region: "IR", from: "agent", lines: [] });
  assert.equal(resolveRegion([], "en-AU", {}).from, "language");
  assert.equal(resolveRegion([], "en-AU", {}).region, "AU");
  assert.deepEqual(resolveRegion([], "fa", { FOLDRUN_REGION: "af" }), { region: "AF", from: "env", lines: [] });
  assert.deepEqual(resolveRegion([], "fa", {}), { region: null, from: "none", lines: [] });
  const bad = resolveRegion([{ level: "workspace", value: "Iran" }, { level: "account", value: "ir" }], "fa", {});
  assert.equal(bad.region, "IR");
  assert.match(bad.lines[0], /workspace says "Iran"/);
});

test("Iran, in Persian: Jalali calendar with today's date in it, Friday weekend, RTL, rials, metric", () => {
  const f = deriveLocale("fa", "IR", {}, "Asia/Tehran", D);
  assert.equal(f.tag, "fa-IR");
  assert.equal(f.calendar, "persian");
  assert.ok(f.dateLocal && /۱۴۰۵/.test(f.dateLocal), `Jalali year in the local date: ${f.dateLocal}`);
  assert.deepEqual(f.weekend, [5]);
  assert.equal(f.weekStart, 6);
  assert.equal(f.direction, "rtl");
  assert.equal(f.currency, "IRR");
  assert.equal(f.units, "metric");
  const prose = localeProse(f, "Persian", regionName("IR"));
  assert.match(prose, /Region: Iran/);
  assert.match(prose, /Calendar: persian — today is/);
  assert.match(prose, /weekend Friday/);
  assert.match(prose, /right to left/);
});

test("Australia, in English: gregorian, Monday-start, Sat–Sun weekend, AUD, metric, no local date repeated", () => {
  const f = deriveLocale("en", "AU", {}, "Australia/Sydney", D);
  assert.equal(f.calendar, "gregory");
  assert.equal(f.dateLocal, null, "gregory would only repeat FOLDRUN_DATE");
  assert.equal(f.weekStart, 1);
  assert.deepEqual(f.weekend, [6, 7]);
  assert.equal(f.currency, "AUD");
  assert.equal(f.units, "metric");
  assert.equal(f.direction, "ltr");
  assert.match(f.dateSample, /17 Sept 2026|17 Sep 2026/);
});

test("the US is imperial; the Gulf's weekend is derived, not assumed", () => {
  assert.equal(deriveLocale("en", "US", {}, "UTC", D).units, "imperial");
  assert.equal(deriveLocale("en", "US", {}, "UTC", D).currency, "USD");
  assert.deepEqual(deriveLocale("ar", "AE", {}, "UTC", D).weekend, [6, 7]);
  assert.equal(deriveLocale("ar", "AE", {}, "UTC", D).direction, "rtl");
});

test("overrides win where derivation can be wrong, and are validated", () => {
  const f = deriveLocale("fa", "IR", { currency: "usd", units: "imperial", calendar: "gregory" }, "UTC", D);
  assert.equal(f.currency, "USD");
  assert.equal(f.units, "imperial");
  assert.equal(f.calendar, "gregory");
  assert.deepEqual(localeProblems({}), []);
  assert.deepEqual(localeProblems({ region: "au", currency: "AUD", units: "metric", calendar: "persian" }), []);
  const bad = localeProblems({ region: "Australia", currency: "dollars", units: "both", calendar: "mayan" });
  assert.equal(bad.length, 4);
});

test("no region at all: metric, no currency, gregorian, and nothing invented", () => {
  const f = deriveLocale("en", null, {}, "UTC", D);
  assert.equal(f.region, null);
  assert.equal(f.currency, null);
  assert.equal(f.units, "metric");
  assert.equal(f.calendar, "gregory");
});
