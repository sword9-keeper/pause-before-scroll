import test from "node:test";
import assert from "node:assert/strict";
import { creditForeground, buildInsights, dayKey, readableTime } from "../insights.js";

function record(start = 100000) {
  return {
    id: "visit", siteId: "douyin", siteName: "抖音", attemptedAt: start, startedAt: start,
    plannedMs: 600000, elapsedMs: 60000, endedAt: null, outcome: "active",
    activityVersion: 1, foregroundMs: 0, foregroundByDay: {}
  };
}

test("foreground credits only observed short gaps, never downtime or negative clock changes", () => {
  const visit = record();
  assert.equal(creditForeground(visit, 100000, 105000), 5000);
  assert.equal(creditForeground(visit, 105000, 106000), 1000);
  assert.equal(creditForeground(visit, 106000, 106000), 0);
  assert.equal(creditForeground(visit, 106000, 100000), 0);
  assert.equal(creditForeground(visit, 106000, 300000), 0);
  assert.equal(creditForeground({ startedAt: 0 }, 0, 5000), 0);
  assert.equal(visit.foregroundMs, 6000);
});

test("foreground splits at local midnight and never exceeds the chosen visit deadline", () => {
  const start = new Date(2026, 9, 13, 23, 59, 57).getTime();
  const visit = record(start);
  visit.plannedMs = 6000;
  assert.equal(creditForeground(visit, start, start + 10000), 6000);
  assert.deepEqual(visit.foregroundByDay, {
    [dayKey(start)]: 3000, [dayKey(start + 6000)]: 3000
  });
  assert.equal(creditForeground(visit, start + 10000, start + 14000), 0);
  assert.equal(visit.foregroundMs, 6000);
});

test("insights distinguish elapsed time, observed time, declined decisions, and legacy unknowns", () => {
  const start = new Date(2026, 9, 13, 12).getTime();
  const measured = { ...record(start), outcome: "left", finishIntent: "done", foregroundMs: 5000, foregroundByDay: { [dayKey(start)]: 5000 } };
  const legacy = { ...record(start), id: "legacy", siteId: "bilibili", siteName: "哔哩哔哩", activityVersion: undefined, foregroundByDay: undefined, outcome: "closed", elapsedMs: 900000 };
  const declined = { ...record(start), id: "declined", startedAt: null, outcome: "declined", elapsedMs: 0 };
  const dismissed = { ...record(start), id: "dismissed", startedAt: null, outcome: "dismissed", elapsedMs: 0 };
  const result = buildInsights([measured, legacy, declined, dismissed], { now: start, days: 7 });
  assert.equal(result.foregroundMs, 5000);
  assert.equal(result.entries, 2);
  assert.equal(result.declined, 1);
  assert.equal(result.decisions, 3);
  assert.equal(result.endedEarly, 1);
  assert.equal(result.legacyVisits, 1);
  assert.equal(result.sites.find(site => site.id === "bilibili").observedRecords, 0);
  assert.equal("savedMinutes" in result, false);
  assert.equal(readableTime(null), "未观测");
});

test("daily foreground attribution includes visits beginning before the chosen date range", () => {
  const today = new Date(2026, 9, 13, 12).getTime();
  const yesterday = new Date(2026, 9, 12, 23, 59).getTime();
  const visit = { ...record(yesterday), foregroundMs: 5000, foregroundByDay: { [dayKey(today)]: 5000 } };
  const result = buildInsights([visit], { now: today, days: 1 });
  assert.equal(result.entries, 0);
  assert.equal(result.foregroundMs, 5000);
  assert.equal(result.daily[0].foregroundMs, 5000);
  assert.ok(result.daily[0].observedRecords > 0);
});
