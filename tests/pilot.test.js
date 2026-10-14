import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyzePilot } from "../scripts/analyze-pilot.mjs";
import { emptyReviews, exportReviews, offsetDay, updateReviews } from "../reviews.js";

function fixture() {
  const beginning = new Date(2026, 9, 1, 20).getTime();
  let state = updateReviews(emptyReviews(), {
    type: "reviewConfigure", revision: 0, consent: true, enabled: true, definition: "Synthetic criterion only"
  }, beginning);
  for (let i = 0; i < 14; i++) {
    const day = offsetDay("2026-10-01", i);
    state = updateReviews(state, { type: "reviewSave", revision: state.revision, report: {
      day, unwantedMinutes: i < 7 ? 20 : 10, fit: "partly",
      protection: i < 7 ? "no" : "yes", displacement: "unsure", interference: "unsure"
    } }, new Date(`${day}T20:00:00`).getTime());
  }
  return exportReviews(state, new Date(2026, 9, 15, 10).getTime());
}
const periods = { baselineStart: "2026-10-01", interventionStart: "2026-10-08" };

test("prospective pilot analysis uses paired weekdays and calls a lower self-estimate descriptive, never causal", () => {
  const result = analyzePilot(fixture(), periods);
  assert.equal(result.pairedWeekdays, 7);
  assert.equal(result.pairedMeanDifferenceMinutes, -10);
  assert.equal(result.status, "descriptive-only");
  assert.equal(result.causalEffect, null);
  assert.equal(result.baseline.counts.protection.no, 7);
  assert.equal(result.intervention.counts.displacement.unsure, 7);
  assert.ok(!JSON.stringify(result).includes("Synthetic criterion"));
});

test("missing answers, late changes, changed definitions, and unfinished periods cannot produce a positive claim", () => {
  const data = fixture();
  data.reports = data.reports.filter(report => !["2026-10-01", "2026-10-02"].includes(report.day));
  data.reports[0].updatedDay = "2026-10-15";
  let result = analyzePilot(data, periods);
  assert.equal(result.baseline.missingDays, 2);
  assert.equal(result.baseline.lateOrRevisedDays, 1);
  assert.equal(result.pairedMeanDifferenceMinutes, null);
  assert.equal(result.baseline.meanSelfReportedMinutes, 20);
  const mixed = fixture();
  mixed.reports[7].definition = "Changed criterion";
  result = analyzePilot(mixed, periods);
  assert.equal(result.pairedMeanDifferenceMinutes, null);
  assert.ok(result.reasons.includes("definition-missing-or-changed"));
  const partial = fixture();
  partial.exportedDay = "2026-10-14";
  result = analyzePilot(partial, periods);
  assert.equal(result.intervention.reportedDays, 6);
  assert.ok(result.reasons.includes("period-not-finished"));
});

test("analysis rejects overlapping phases, invalid dates, and non-review input", () => {
  assert.throws(() => analyzePilot(fixture(), { ...periods, interventionStart: "2026-10-07" }), /overlap/);
  assert.throws(() => analyzePilot(fixture(), { ...periods, baselineStart: "2026-02-30" }), /valid/);
  assert.throws(() => analyzePilot({ kind: "records" }, periods), /self-review/);
});

test("the documented CLI reads a synthetic export without changing it and reports missing arguments", async () => {
  const output = new URL("../test-results/", import.meta.url);
  await mkdir(output, { recursive: true });
  const filename = new URL("pilot-synthetic-fixture.json", output);
  const content = JSON.stringify(fixture());
  await writeFile(filename, content);
  const command = fileURLToPath(new URL("../scripts/analyze-pilot.mjs", import.meta.url));
  const result = execFileSync(process.execPath, [command, fileURLToPath(filename), "2026-10-01", "2026-10-08"], { encoding: "utf8" });
  assert.equal(JSON.parse(result).status, "descriptive-only");
  assert.equal(await readFile(filename, "utf8"), content);
  assert.throws(() => execFileSync(process.execPath, [command], { encoding: "utf8", stdio: "pipe" }),
    error => error.status === 1 && error.stderr.includes("Usage:"));
});
