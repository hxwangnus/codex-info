export function localDateKey(value) {
  const date = asDate(value);
  if (!date) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

export function isoWeekKey(value) {
  const date = asDate(value);
  if (!date) return "";
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = local.getDay() || 7;
  local.setDate(local.getDate() + 4 - day);
  const yearStart = new Date(local.getFullYear(), 0, 1);
  const week = Math.ceil((((local - yearStart) / 86400000) + 1) / 7);
  return `${local.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function startOfLocalToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function startOfLocalIsoWeek(now = new Date()) {
  const today = startOfLocalToday(now);
  const day = today.getDay() || 7;
  today.setDate(today.getDate() - day + 1);
  return today;
}

export function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function localYearRange(year) {
  const numericYear = Number(year);
  return {
    start: new Date(numericYear, 0, 1),
    end: new Date(numericYear + 1, 0, 1)
  };
}

export function dayKeyInRange(dayKey, options = {}) {
  if (!dayKey) return false;
  const day = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(day.getTime())) return false;
  if (options.sinceTime && day < startOfLocalToday(new Date(options.sinceTime))) return false;
  if (options.untilTime && day >= startOfLocalToday(new Date(options.untilTime))) return false;
  if (options.year && !dayKey.startsWith(`${options.year}-`)) return false;
  if (options.since && day < startOfDateOption(options.since)) return false;
  if (options.until && day >= addDays(startOfDateOption(options.until), 1)) return false;
  return true;
}

export function timestampInRange(value, options = {}) {
  const date = asDate(value);
  if (!date) return false;
  if (options.sinceTime && date < new Date(options.sinceTime)) return false;
  if (options.untilTime && date >= new Date(options.untilTime)) return false;
  if (options.year && localDateKey(date).slice(0, 4) !== String(options.year)) return false;
  if (options.since && date < startOfDateOption(options.since)) return false;
  if (options.until && date >= addDays(startOfDateOption(options.until), 1)) return false;
  return true;
}

export function hasDateFilter(options = {}) {
  return Boolean(options.year || options.since || options.until || options.sinceTime || options.untilTime);
}

function startOfDateOption(value) {
  const text = String(value);
  const date = text.length <= 10 ? new Date(`${text}T00:00:00`) : new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
