import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const TOKEN_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens"
];

export function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

export function addUsage(target, usage) {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningOutputTokens += usage.reasoningOutputTokens;
  target.totalTokens += usage.totalTokens;
  return target;
}

export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const inputTokens = numberFrom(raw.input_tokens);
  const cachedInputTokens = numberFrom(raw.cached_input_tokens ?? raw.cache_read_input_tokens);
  const outputTokens = numberFrom(raw.output_tokens);
  const reasoningOutputTokens = numberFrom(raw.reasoning_output_tokens);
  const explicitTotal = numberFrom(raw.total_tokens);
  const fallbackTotal = inputTokens + outputTokens;
  const totalTokens = explicitTotal > 0 ? explicitTotal : fallbackTotal;

  if (inputTokens + cachedInputTokens + outputTokens + reasoningOutputTokens + totalTokens <= 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

export function diffUsage(total, previous) {
  const delta = emptyUsage();
  for (const key of Object.keys(delta)) {
    delta[key] = Math.max(0, total[key] - (previous?.[key] || 0));
  }
  if (delta.totalTokens <= 0) {
    delta.totalTokens = delta.inputTokens + delta.outputTokens;
  }
  return delta.totalTokens + delta.inputTokens + delta.outputTokens + delta.reasoningOutputTokens > 0
    ? delta
    : null;
}

export async function collectUsage(options = {}) {
  const codexHomes = codexHomeList(options).map((home) => path.resolve(expandHome(home)));
  const sessionRoots = codexHomes.map((home) => path.join(home, "sessions"));
  const files = [];
  for (const codexHome of codexHomes) {
    const roots = [path.join(codexHome, "sessions")];
    if (options.includeArchived) roots.push(path.join(codexHome, "archived_sessions"));
    for (const root of roots) {
      files.push(...await listSessionFiles(root, options));
    }
  }
  const summary = createSummary(codexHomes, sessionRoots);
  const sessions = [];
  const dayMap = new Map();
  const modelMap = new Map();
  const projectMap = new Map();
  const seenSessions = new Set();

  for (const file of files) {
    const session = await parseSessionFile(file, options);
    if (!session || !isSessionInRange(session, options)) continue;
    if (seenSessions.has(session.id)) {
      summary.duplicateSessions += 1;
      continue;
    }
    seenSessions.add(session.id);

    sessions.push(session);
    addUsage(summary.usage, session.usage);
    summary.tokenEvents += session.tokenEvents;
    summary.userMessages += session.userMessages;
    summary.parseErrors += session.parseErrors;
    summary.skippedTokenEvents += session.skippedTokenEvents;

    if (session.startedAt) summary.activeDays.add(toDateKey(session.startedAt));
    for (const day of session.activeDays) summary.activeDays.add(day);
    if (session.project) summary.projects.add(session.project);
    if (session.model) summary.models.add(session.model);

    addGroup(dayMap, toDateKey(session.lastActivityAt || session.startedAt), session);
    addGroup(modelMap, session.model || "unknown", session);
    addGroup(projectMap, projectLabel(session.project, options), session);
  }

  summary.sessions = sessions.length;
  summary.activeDayCount = summary.activeDays.size;
  summary.projectCount = summary.projects.size;
  summary.modelCount = summary.models.size;
  summary.filesScanned = files.length;
  summary.dateRange = getDateRange(sessions);

  return {
    summary: finalizeSummary(summary),
    groups: {
      day: finalizeGroups(dayMap, "date"),
      model: finalizeGroups(modelMap, "model"),
      project: finalizeGroups(projectMap, "project")
    },
    sessions: sessions
      .sort((a, b) => (b.usage.totalTokens || 0) - (a.usage.totalTokens || 0))
      .map((session) => serializeSession(session, options))
  };
}

export async function listSessionFiles(sessionsRoot, options = {}) {
  if (!fs.existsSync(sessionsRoot)) return [];
  const files = [];
  const year = options.year ? String(options.year) : null;
  const flatArchive = path.basename(sessionsRoot) === "archived_sessions";
  const startDir = year && !flatArchive ? path.join(sessionsRoot, year) : sessionsRoot;
  if (!fs.existsSync(startDir)) return [];

  async function walk(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }

  await walk(startDir);
  return files.sort();
}

export async function parseSessionFile(file, options = {}) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  const session = {
    id: sessionIdFromPath(file),
    file,
    startedAt: null,
    lastActivityAt: null,
    project: "",
    source: "",
    cliVersion: "",
    modelProvider: "",
    model: "",
    effort: "",
    userMessages: 0,
    tokenEvents: 0,
    skippedTokenEvents: 0,
    parseErrors: 0,
    activeDays: new Set(),
    usage: emptyUsage()
  };
  let previousTotal = null;
  let currentModel = "";

  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      session.parseErrors += 1;
      continue;
    }

    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload : {};
    const timestamp = parseTimestamp(payload.timestamp || entry.timestamp);
    if (timestamp) session.lastActivityAt = maxDate(session.lastActivityAt, timestamp);

    if (entry.type === "session_meta") {
      session.startedAt = parseTimestamp(payload.timestamp || entry.timestamp) || session.startedAt;
      session.project = payload.cwd || session.project;
      session.source = payload.source || session.source;
      session.cliVersion = payload.cli_version || session.cliVersion;
      session.modelProvider = payload.model_provider || session.modelProvider;
      continue;
    }

    if (entry.type === "turn_context") {
      if (payload.cwd) session.project = payload.cwd;
      if (payload.model) {
        currentModel = payload.model;
        session.model = payload.model;
      }
      if (payload.effort) session.effort = payload.effort;
      continue;
    }

    if (entry.type !== "event_msg") continue;

    if (payload.type === "user_message") {
      session.userMessages += 1;
      if (timestamp) session.activeDays.add(toDateKey(timestamp));
      continue;
    }

    if (payload.type !== "token_count") continue;

    const info = payload.info && typeof payload.info === "object" ? payload.info : {};
    const model = extractModel(payload, info) || currentModel || session.model;
    if (model) session.model = model;

    const totalUsage = normalizeUsage(info.total_token_usage);
    let usage = totalUsage ? diffUsage(totalUsage, previousTotal) : null;
    if (totalUsage) previousTotal = totalUsage;
    if (!totalUsage) usage = normalizeUsage(info.last_token_usage);

    if (!usage) {
      session.skippedTokenEvents += 1;
      continue;
    }

    session.tokenEvents += 1;
    addUsage(session.usage, usage);
    if (timestamp) session.activeDays.add(toDateKey(timestamp));
  }

  session.startedAt = session.startedAt || dateFromPath(file);
  if (!session.lastActivityAt) session.lastActivityAt = session.startedAt;
  if (!session.model) session.model = currentModel || "unknown";
  return session.tokenEvents || session.userMessages || session.startedAt ? session : null;
}

function createSummary(codexHomes, sessionRoots) {
  return {
    codexHome: codexHomes.length === 1 ? codexHomes[0] : codexHomes,
    codexHomes,
    sessionsRoot: sessionRoots.length === 1 ? sessionRoots[0] : sessionRoots,
    sessionRoots,
    sessions: 0,
    filesScanned: 0,
    duplicateSessions: 0,
    tokenEvents: 0,
    userMessages: 0,
    activeDays: new Set(),
    activeDayCount: 0,
    projects: new Set(),
    projectCount: 0,
    models: new Set(),
    modelCount: 0,
    parseErrors: 0,
    skippedTokenEvents: 0,
    usage: emptyUsage(),
    dateRange: null
  };
}

function finalizeSummary(summary) {
  return {
    codexHome: summary.codexHome,
    codexHomes: summary.codexHomes,
    sessionsRoot: summary.sessionsRoot,
    sessionRoots: summary.sessionRoots,
    sessions: summary.sessions,
    filesScanned: summary.filesScanned,
    duplicateSessions: summary.duplicateSessions,
    tokenEvents: summary.tokenEvents,
    userMessages: summary.userMessages,
    activeDays: summary.activeDayCount,
    projects: summary.projectCount,
    models: summary.modelCount,
    parseErrors: summary.parseErrors,
    skippedTokenEvents: summary.skippedTokenEvents,
    dateRange: summary.dateRange,
    usage: summary.usage
  };
}

function addGroup(map, key, session) {
  if (!key) return;
  const group = map.get(key) || {
    key,
    sessions: 0,
    userMessages: 0,
    tokenEvents: 0,
    usage: emptyUsage()
  };
  group.sessions += 1;
  group.userMessages += session.userMessages;
  group.tokenEvents += session.tokenEvents;
  addUsage(group.usage, session.usage);
  map.set(key, group);
}

function finalizeGroups(map, keyName) {
  return Array.from(map.values())
    .sort((a, b) => {
      if (keyName === "date") return String(a.key).localeCompare(String(b.key));
      return (b.usage.totalTokens || 0) - (a.usage.totalTokens || 0);
    })
    .map((group) => ({
      [keyName]: group.key,
      sessions: group.sessions,
      userMessages: group.userMessages,
      tokenEvents: group.tokenEvents,
      usage: group.usage
    }));
}

function serializeSession(session, options) {
  return {
    id: session.id,
    startedAt: session.startedAt?.toISOString() || null,
    lastActivityAt: session.lastActivityAt?.toISOString() || null,
    project: projectLabel(session.project, options),
    model: session.model || "unknown",
    effort: session.effort || "",
    source: session.source || "",
    cliVersion: session.cliVersion || "",
    userMessages: session.userMessages,
    tokenEvents: session.tokenEvents,
    usage: session.usage,
    file: options.includeFiles ? session.file : undefined
  };
}

function getDateRange(sessions) {
  let start = null;
  let end = null;
  for (const session of sessions) {
    if (session.startedAt) start = minDate(start, session.startedAt);
    if (session.lastActivityAt) end = maxDate(end, session.lastActivityAt);
  }
  return start || end
    ? {
        start: start?.toISOString() || null,
        end: end?.toISOString() || null
      }
    : null;
}

function isSessionInRange(session, options) {
  const date = session.startedAt || session.lastActivityAt;
  if (!date) return true;
  if (options.year && String(date.getUTCFullYear()) !== String(options.year)) return false;
  if (options.since && date < startOfDay(options.since)) return false;
  if (options.until && date >= dayAfter(options.until)) return false;
  return true;
}

function extractModel(payload, info) {
  return (
    info?.model ||
    info?.model_name ||
    info?.metadata?.model ||
    payload?.model ||
    payload?.metadata?.model ||
    ""
  );
}

function numberFrom(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function startOfDay(value) {
  const text = String(value);
  const date = text.length <= 10 ? new Date(`${text}T00:00:00.000Z`) : new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function dayAfter(value) {
  const date = startOfDay(value);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function minDate(left, right) {
  if (!left) return right;
  return right < left ? right : left;
}

function maxDate(left, right) {
  if (!left) return right;
  return right > left ? right : left;
}

function sessionIdFromPath(file) {
  const base = path.basename(file, ".jsonl");
  const match = base.match(/rollout-[^-]+-\d\d-\d\dT\d\d-\d\d-\d\d-(.+)$/);
  return match?.[1] || base;
}

function dateFromPath(file) {
  const parts = file.split(path.sep);
  const index = parts.lastIndexOf("sessions");
  if (index < 0 || parts.length < index + 4) return dateFromFilename(file);
  const [year, month, day] = parts.slice(index + 1, index + 4);
  const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? dateFromFilename(file) : date;
}

function dateFromFilename(file) {
  const match = path.basename(file).match(/rollout-(\d{4})-(\d{2})-(\d{2})T/);
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function projectLabel(project, options) {
  if (!project) return "unknown";
  return options.includeProjectPaths ? project : path.basename(project);
}

function expandHome(value) {
  if (!value || value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function knownTokenKeys() {
  return TOKEN_KEYS.slice();
}

function codexHomeList(options) {
  if (Array.isArray(options.codexHomes) && options.codexHomes.length) return options.codexHomes;
  if (options.codexHome) return [options.codexHome];
  return [defaultCodexHome()];
}
