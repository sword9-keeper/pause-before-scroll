import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { offsetDay, validateReviews, REVIEW_OPTIONS } from "../reviews.js";

function date(value) {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || offsetDay(value, 0) !== value) throw new Error();
  } catch { throw new Error("Expected a valid YYYY-MM-DD date."); }
  return value;
}

export function analyzePilot(data, { baselineStart, interventionStart }) {
  date(baselineStart);
  date(interventionStart);
  if (interventionStart < offsetDay(baselineStart, 7)) throw new Error("The two seven-day periods must not overlap.");
  if (data?.app !== "back-to-flow" || data.kind !== "daily-self-review" || data.schemaVersion !== 1) {
    throw new Error("Expected a daily self-review export, not browsing records.");
  }
  date(data.exportedDay);
  const state = validateReviews({ ...data, revision: 0 });
  function period(start) {
    const end = offsetDay(start, 6);
    const reports = state.reports.filter(report => report.day >= start && report.day <= end && report.day < data.exportedDay);
    const timely = reports.filter(report => report.submittedDay >= report.day &&
      report.submittedDay <= offsetDay(report.day, 1) && report.updatedDay >= report.day &&
      report.updatedDay <= offsetDay(report.day, 1));
    const numeric = timely.filter(report => report.unwantedMinutes !== null);
    const counts = Object.fromEntries(Object.entries(REVIEW_OPTIONS).map(([key, options]) => [
      key, Object.fromEntries(Object.keys(options).map(option => [option, reports.filter(report => report[key] === option).length]))
    ]));
    const definitions = new Set(reports.map(report => report.definition));
    return {
      start, end, elapsed: end < data.exportedDay,
      reportedDays: reports.length, missingDays: 7 - reports.length,
      timelyNumericDays: numeric.length, lateOrRevisedDays: reports.length - timely.length,
      meanSelfReportedMinutes: numeric.length && definitions.size === 1 ?
        numeric.reduce((sum, report) => sum + report.unwantedMinutes, 0) / numeric.length : null,
      counts, numeric, definitions: [...definitions]
    };
  }
  const baseline = period(baselineStart);
  const intervention = period(interventionStart);
  const definitions = new Set([...baseline.definitions, ...intervention.definitions]);
  const weekday = day => new Date(`${day}T12:00:00Z`).getUTCDay();
  const pairs = baseline.numeric.flatMap(before => {
    const after = intervention.numeric.find(item => weekday(item.day) === weekday(before.day));
    return after ? [after.unwantedMinutes - before.unwantedMinutes] : [];
  });
  const reasons = [];
  if (!baseline.elapsed || !intervention.elapsed) reasons.push("period-not-finished");
  if (definitions.size !== 1) reasons.push("definition-missing-or-changed");
  if (baseline.timelyNumericDays < 5 || intervention.timelyNumericDays < 5 || pairs.length < 5) reasons.push("insufficient-timely-paired-days");
  const publicPeriod = ({ numeric, definitions, ...rest }) => rest;
  return {
    analysisVersion: 1, kind: "single-person-descriptive-pilot",
    outcome: "self-estimated unwanted browsing minutes, including other devices",
    baseline: publicPeriod(baseline), intervention: publicPeriod(intervention),
    pairedWeekdays: pairs.length, status: reasons.length ? "insufficient-or-incomparable" : "descriptive-only",
    reasons,
    pairedMeanDifferenceMinutes: reasons.length ? null : pairs.reduce((sum, difference) => sum + difference, 0) / pairs.length,
    causalEffect: null,
    limitations: [
      "Self-report, not measured screen time or verified attention.",
      "No randomization: calendar changes, recall, reactivity, and displacement can affect the comparison.",
      "No missing-day imputation. Later revisions are excluded from the primary paired summary, not erased.",
      "Protection use, unknown responses, interference, and displacement are reported, not silently excluded.",
      "One voluntary export does not represent nonresponders or dropouts."
    ]
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [filename, baselineStart, interventionStart, ...extra] = process.argv.slice(2);
    if (!filename || !baselineStart || !interventionStart || extra.length) {
      throw new Error("Usage: node scripts/analyze-pilot.mjs EXPORT.json BASELINE_START INTERVENTION_START");
    }
    const bytes = await readFile(filename);
    if (bytes.byteLength > 4 * 1024 * 1024) throw new Error("Export exceeds the 4 MB analysis input limit.");
    console.log(JSON.stringify(analyzePilot(JSON.parse(bytes.toString("utf8")), { baselineStart, interventionStart }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
