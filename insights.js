export const MAX_FOREGROUND_GAP_MS = 15000;

export function dayKey(time) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function creditForeground(record, from, until) {
  if (record?.activityVersion !== 1 || !Number.isFinite(from) || !Number.isFinite(until) ||
      until < from || until - from > MAX_FOREGROUND_GAP_MS || !Number.isFinite(record.startedAt) ||
      !Number.isFinite(record.plannedMs)) return 0;
  const start = Math.max(from, record.startedAt);
  const end = Math.min(until, record.startedAt + record.plannedMs, record.endedAt ?? Infinity);
  let remaining = Math.min(Math.max(0, end - start), Math.max(0, record.plannedMs - record.foregroundMs));
  let cursor = start;
  const credited = remaining;
  while (remaining > 0) {
    const midnight = new Date(cursor);
    midnight.setHours(24, 0, 0, 0);
    const part = Math.min(remaining, midnight.getTime() - cursor);
    const key = dayKey(cursor);
    record.foregroundByDay[key] = (record.foregroundByDay[key] || 0) + part;
    record.foregroundMs += part;
    remaining -= part;
    cursor += part;
  }
  return credited;
}

export function buildInsights(records, { now = Date.now(), days = 7 } = {}) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const daily = Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setDate(date.getDate() - days + index + 1);
    return { key: dayKey(date), label: `${date.getMonth() + 1}/${date.getDate()}`, foregroundMs: 0, entries: 0, declined: 0, observedRecords: 0 };
  });
  const byDay = new Map(daily.map(day => [day.key, day]));
  const summary = {
    daily, foregroundMs: 0, entries: 0, declined: 0, endedEarly: 0,
    decisions: 0, observedRecords: 0, legacyVisits: 0, sites: []
  };
  const sites = new Map();
  for (const record of records) {
    const day = byDay.get(dayKey(record.attemptedAt));
    const entry = record.startedAt !== null && Number.isFinite(record.startedAt);
    const visible = Object.entries(record.foregroundByDay || {})
      .filter(([key]) => byDay.has(key)).reduce((sum, [, value]) => sum + value, 0);
    if (!day && !visible) continue;
    if (!sites.has(record.siteId)) sites.set(record.siteId, {
      id: record.siteId, name: record.siteName, entries: 0, declined: 0, foregroundMs: 0, observedRecords: 0
    });
    const site = sites.get(record.siteId);
    if (record.activityVersion === 1) {
      summary.observedRecords++;
      site.observedRecords++;
      if (day) day.observedRecords++;
      summary.foregroundMs += visible;
      site.foregroundMs += visible;
      for (const [key, amount] of Object.entries(record.foregroundByDay)) {
        if (byDay.has(key)) {
          byDay.get(key).foregroundMs += amount;
          if (key !== day?.key) byDay.get(key).observedRecords++;
        }
      }
    } else if (day && entry) summary.legacyVisits++;
    if (!day) continue;
    if (entry) { summary.entries++; day.entries++; site.entries++; }
    if (record.outcome === "declined") { summary.declined++; day.declined++; site.declined++; }
    if (record.finishIntent === "done") summary.endedEarly++;
    if (entry || record.outcome === "declined") summary.decisions++;
  }
  summary.sites = [...sites.values()].sort((a, b) => b.foregroundMs - a.foregroundMs || b.entries - a.entries);
  return summary;
}

export function readableTime(milliseconds) {
  if (milliseconds === null || milliseconds === undefined) return "未观测";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

export function compactTime(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}分` : `${Math.floor(minutes / 60)}时${minutes % 60}分`;
}
