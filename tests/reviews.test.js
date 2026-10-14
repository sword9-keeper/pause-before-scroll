import test from "node:test";
import assert from "node:assert/strict";
import { dayKey } from "../insights.js";
import { emptyReviews, validateReviews, updateReviews, summarizeReviews, exportReviews, offsetDay } from "../reviews.js";

const now = new Date(2026, 9, 14, 20).getTime();
const today = dayKey(now);
const input = day => ({ day, unwantedMinutes: null, fit: "partly", protection: "yes", displacement: "unsure", interference: "unsure" });
function update(state, action, time = now) { return updateReviews(state, { revision: state.revision, ...action }, time); }
function enable() {
  return update(emptyReviews(), { type: "reviewConfigure", enabled: true, consent: true, definition: "Unplanned short videos across my devices" });
}

test("daily reviews are opt-in, preserve null estimates, and accept an intentional zero", () => {
  const initial = emptyReviews();
  assert.equal(initial.enabled, false);
  assert.throws(() => update(initial, { type: "reviewSave", report: input(today) }), /尚未开启/);
  assert.throws(() => update(initial, { type: "reviewConfigure", enabled: true, definition: "Goal" }), /同意/);
  let state = enable();
  state = update(state, { type: "reviewSave", report: input(today) });
  assert.equal(state.reports[0].unwantedMinutes, null);
  state = update(state, { type: "reviewSave", report: { ...input(today), unwantedMinutes: 0 } });
  assert.equal(state.reports[0].unwantedMinutes, 0);
  assert.equal(state.reports.length, 1);
  for (const unwantedMinutes of [-1, 1441, 1.5, "", false, NaN]) {
    assert.throws(() => update(state, { type: "reviewSave", report: { ...input(today), unwantedMinutes } }), /分钟/);
  }
  assert.throws(() => update(state, { type: "reviewSave", report: { ...input(today), fit: ["yes"] } }), /选项/);
});

test("new answers cannot fabricate old or future diary days and invalid calendar dates are rejected", () => {
  const state = enable();
  for (const day of ["2026-02-30", offsetDay(today, 1), offsetDay(today, -2), "2026-1-1", "not-a-day"]) {
    assert.throws(() => update(state, { type: "reviewSave", report: input(day) }), /今天或昨天/);
  }
  assert.equal(update(state, { type: "reviewSave", report: input(offsetDay(today, -1)) }).reports.length, 1);
  assert.equal(offsetDay("2026-03-08", 1), "2026-03-09");
  assert.equal(offsetDay("2024-03-01", -1), "2024-02-29");
});

test("changing the definition never relabels existing answers; later edits retain first submission metadata", () => {
  let state = enable();
  state = update(state, { type: "reviewSave", report: input(today) });
  const original = state.reports[0];
  state = update(state, { type: "reviewConfigure", enabled: true, consent: true, definition: "A different definition" });
  state = update(state, { type: "reviewSave", report: { ...input(today), unwantedMinutes: 12 } }, now + 3 * 86400000);
  assert.equal(state.reports[0].definition, original.definition);
  assert.equal(state.reports[0].createdAt, original.createdAt);
  assert.equal(state.reports[0].submittedDay, today);
  assert.equal(state.reports[0].updatedDay, offsetDay(today, 3));
  state = update(state, { type: "reviewSave", report: input(offsetDay(today, 3)) }, now + 3 * 86400000);
  assert.equal(state.reports[1].definition, "A different definition");
});

test("revision guards prevent concurrent overwrites and resurrection after erase; disabling retains answers", () => {
  let state = enable();
  const stale = state.revision;
  state = update(state, { type: "reviewSave", report: input(today) });
  assert.throws(() => updateReviews(state, { type: "reviewSave", revision: stale, report: input(today) }, now), /另一页面/);
  state = update(state, { type: "reviewConfigure", enabled: false, definition: state.definition });
  assert.equal(state.reports.length, 1);
  assert.throws(() => update(state, { type: "reviewSave", report: input(today) }), /尚未开启/);
  assert.throws(() => update(state, { type: "reviewErase" }), /确认/);
  const erased = update(state, { type: "reviewErase", confirmed: true });
  assert.equal(erased.enabled, false);
  assert.equal(erased.definition, "");
  assert.equal(erased.reports.length, 0);
  assert.throws(() => updateReviews(erased, { type: "reviewSave", revision: state.revision, report: input(today) }, now), /另一页面/);
});

test("summaries exclude today, never fill missing days with zero, and refuse mixed-definition comparisons", () => {
  let state = enable();
  for (let index = 14; index >= 0; index--) {
    const day = offsetDay(today, -index);
    state = update(state, { type: "reviewSave", report: { ...input(day), unwantedMinutes: index === 14 ? null : index === 0 ? 999 : 10 } },
      new Date(`${day}T20:00:00`).getTime());
  }
  let summary = summarizeReviews(state, today);
  assert.equal(summary.previous.numericDays, 6);
  assert.equal(summary.previous.meanMinutes, 10);
  assert.equal(summary.recent.meanMinutes, 10);
  assert.equal(summary.status, "descriptive-only");
  assert.equal(summary.recent.counts.displacement.unsure, 7);
  state = update(state, { type: "reviewRemove", day: offsetDay(today, -1) });
  summary = summarizeReviews(state, today);
  assert.equal(summary.recent.missingDays, 1);
  assert.equal(summary.recent.meanMinutes, 10);
  state.reports[1].definition = "Different";
  summary = summarizeReviews(state, today);
  assert.equal(summary.status, "different-definitions");
  assert.equal(summary.previous.meanMinutes, null);
  assert.equal("savedMinutes" in summary, false);
});

test("exports whitelist self-reports, omit arbitrary data, and corrupt data is never silently reset", () => {
  let state = enable();
  state = update(state, { type: "reviewSave", report: { ...input(today), url: "secret-url", password: "secret-password" } });
  const data = exportReviews({ ...state, syncConfig: { password: "secret" } }, now);
  assert.equal(data.kind, "daily-self-review");
  assert.equal(data.exportedDay, today);
  assert.ok(!JSON.stringify(data).includes("secret"));
  assert.throws(() => validateReviews({ ...state, schemaVersion: 9 }), /不兼容/);
  assert.throws(() => validateReviews({ ...state, enabled: false, consentedAt: null }), /不兼容/);
  assert.throws(() => validateReviews({ ...state, reports: [state.reports[0], state.reports[0]] }), /日期/);
  assert.throws(() => validateReviews({ ...state, reports: Array(2001).fill(state.reports[0]) }), /不兼容/);
});
