import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { addUsage, emptyUsage } from "./usage.js";
import { dayKeyInRange, isoWeekKey, localDateKey, timestampInRange } from "./date-utils.js";
import { renderHeatmapPng } from "./heatmap-png.js";
import { renderHtmlReport } from "./format.js";

const SYNC_SCHEMA_VERSION = 1;
const DATA_DIR = "codex-info/devices";

export async function syncGitUsage(localResult, options = {}) {
  const repoUrl = options.syncGit;
  if (!repoUrl) return localResult;

  const branch = options.syncBranch || "main";
  const device = safeDeviceName(options.syncDevice || os.hostname() || "unknown-device");
  const worktree = syncWorktree(repoUrl, options.syncCache);

  ensureGitRepo(repoUrl, worktree, branch);

  const before = readAllDeviceFiles(worktree);
  const currentPath = path.join(worktree, DATA_DIR, `${device}.json`);
  const current = before.deviceFiles.get(device) || emptyDeviceFile(device);
  const localRecords = localResult.sessions.map((session) => sessionToRecord(session, device, options));
  const mergeStats = mergeRecordsIntoDevice(current, localRecords);

  await fs.promises.mkdir(path.dirname(currentPath), { recursive: true });
  await fs.promises.writeFile(currentPath, `${stableJson(current)}\n`, "utf8");

  const changed = hasGitChanges(worktree);
  let pushed = false;
  if (changed) {
    git(worktree, ["add", currentPath]);
    git(worktree, ["commit", "-m", `Update Codex usage for ${device}`], { commitEnv: true });
    pushed = pushWithRetry(worktree, branch);
  }

  const after = readAllDeviceFiles(worktree);
  const records = allRecords(after.deviceFiles);
  const devicesLastSynced = deviceSyncTimes(after.deviceFiles);
  const merged = aggregateRecords(records, {
    ...options,
    syncSummary: {
      device,
      repoUrl,
      branch,
      worktree,
      pushed,
      addedSessions: mergeStats.added,
      updatedSessions: mergeStats.updated,
      devices: after.deviceFiles.size,
      devicesLastSynced,
      remoteRecords: records.length
    }
  });

  return merged;
}

export async function updateSyncReadme(result, options = {}) {
  const repoUrl = options.syncGit;
  if (!repoUrl) return { pushed: false, skipped: true };

  const branch = options.syncBranch || "main";
  const device = safeDeviceName(options.syncDevice || os.hostname() || "unknown-device");
  const worktree = syncWorktree(repoUrl, options.syncCache);

  ensureGitRepo(repoUrl, worktree, branch);

  const pngRelativePath = "assets/codex-usage-heatmap.png";
  const htmlRelativePath = syncOutputPath(options.html);
  const readmePath = path.join(worktree, "README.md");
  const pngPath = path.join(worktree, pngRelativePath);
  const htmlPath = htmlRelativePath ? path.join(worktree, htmlRelativePath) : "";
  const writeReadme = options.syncReadme !== false;
  const writePng = writeReadme;
  const changedPaths = [];

  if (writePng) {
    await fs.promises.mkdir(path.dirname(pngPath), { recursive: true });
    await fs.promises.writeFile(pngPath, renderHeatmapPng(result, options));
    changedPaths.push(pngPath);
  }

  if (writeReadme) {
    await fs.promises.writeFile(readmePath, renderSyncReadme(result, options, pngRelativePath, htmlRelativePath), "utf8");
    changedPaths.push(readmePath);
  }

  if (htmlRelativePath) {
    await fs.promises.mkdir(path.dirname(htmlPath), { recursive: true });
    await fs.promises.writeFile(htmlPath, renderHtmlReport(result, {
      ...options,
      heatmapImage: writePng ? relativeUrl(path.posix.dirname(htmlRelativePath), pngRelativePath) : ""
    }), "utf8");
    changedPaths.push(htmlPath);
  }

  const changed = hasGitChanges(worktree);
  let pushed = false;
  if (changed) {
    git(worktree, ["add", ...changedPaths]);
    git(worktree, ["commit", "-m", `Update Codex usage report for ${device}`], { commitEnv: true });
    pushed = pushWithRetry(worktree, branch);
  }

  return {
    pushed,
    worktree,
    readme: writeReadme ? "README.md" : null,
    png: writePng ? pngRelativePath : null,
    html: htmlRelativePath || null,
    htmlPath: htmlPath || null
  };
}

function syncOutputPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text)) {
    throw new Error("--html must be a relative path when used with --sync-git so the report stays inside the private sync repo.");
  }
  const normalized = path.posix.normalize(text.replace(/\\/g, "/"));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Invalid sync output path: ${value}`);
  }
  return normalized;
}

function relativeUrl(fromDir, target) {
  const relative = path.posix.relative(fromDir || ".", target);
  return relative || path.posix.basename(target);
}

function ensureGitRepo(repoUrl, worktree, branch) {
  if (!fs.existsSync(path.join(worktree, ".git"))) {
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    execFileSync("git", ["clone", repoUrl, worktree], { stdio: "pipe" });
  }

  const currentUrl = git(worktree, ["remote", "get-url", "origin"], { optional: true })?.trim();
  if (currentUrl && currentUrl !== repoUrl) {
    throw new Error(`Sync cache already points to a different repo: ${currentUrl}`);
  }

  git(worktree, ["fetch", "origin"], { optional: true });
  const hasRemoteBranch = Boolean(git(worktree, ["rev-parse", "--verify", `origin/${branch}`], { optional: true }));
  if (hasRemoteBranch) {
    git(worktree, ["checkout", "-B", branch, `origin/${branch}`]);
    git(worktree, ["pull", "--rebase", "origin", branch], { optional: true });
  } else {
    git(worktree, ["checkout", "-B", branch]);
  }
}

function renderSyncReadme(result, options, pngRelativePath, htmlRelativePath = "") {
  const summary = result.summary || {};
  const usage = summary.usage || emptyUsage();
  const titleRange = reportRangeLabel(result, options);
  const generatedAt = new Date().toISOString();
  const lines = [
    "# Codex Usage Report",
    "",
    `Generated: ${generatedAt}`,
    `Range: ${titleRange}`,
    "",
    `![Codex usage heatmap](${pngRelativePath}?v=${encodeURIComponent(generatedAt)})`,
    ""
  ];

  if (htmlRelativePath) {
    lines.push(`[Open interactive HTML report](${htmlRelativePath})`, "");
  }

  lines.push(
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Sessions | ${formatNumber(summary.sessions)} |`,
    `| User messages | ${formatNumber(summary.userMessages)} |`,
    `| Active days | ${formatNumber(summary.activeDays)} |`,
    `| Projects | ${formatNumber(summary.projects)} |`,
    `| Devices | ${formatNumber(summary.devices || summary.sync?.devices || 1)} |`,
    `| Total tokens | ${formatNumber(usage.totalTokens)} |`,
    `| Input tokens | ${formatNumber(usage.inputTokens)} |`,
    `| Cached input tokens | ${formatNumber(usage.cachedInputTokens)} |`,
    `| Output tokens | ${formatNumber(usage.outputTokens)} |`,
    `| Reasoning tokens | ${formatNumber(usage.reasoningOutputTokens)} |`
  );

  if (typeof summary.estimatedCostUSD === "number") {
    lines.push(`| Estimated cost | ${formatUsd(summary.estimatedCostUSD)} |`);
  }

  lines.push("", "## Top Models", "");
  const models = (result.groups?.model || []).slice(0, 10);
  if (models.length) {
    const hasCost = models.some((row) => typeof row.estimatedCostUSD === "number");
    lines.push(hasCost ? "| Model | Tokens | Cost |" : "| Model | Tokens |");
    lines.push(hasCost ? "| --- | ---: | ---: |" : "| --- | ---: |");
    for (const row of models) {
      const model = escapeMarkdown(row.model || "unknown");
      const tokens = formatNumber(row.usage?.totalTokens);
      if (hasCost) {
        lines.push(`| ${model} | ${tokens} | ${formatUsd(row.estimatedCostUSD)} |`);
      } else {
        lines.push(`| ${model} | ${tokens} |`);
      }
    }
  } else {
    lines.push("No model data.");
  }

  lines.push("", "## Device Sync", "");
  const devices = summary.sync?.devicesLastSynced || [];
  if (devices.length) {
    lines.push("| Device | Last synced | Sessions |");
    lines.push("| --- | --- | ---: |");
    for (const row of devices) {
      lines.push(`| ${escapeMarkdown(row.device)} | ${formatTimestamp(row.updatedAt)} | ${formatNumber(row.sessions)} |`);
    }
  } else {
    lines.push("Local-only report.");
  }

  lines.push(
    "",
    "## Privacy",
    "",
    "This repo is intended to stay private. It stores aggregated Codex usage summaries, hashed session ids, project basename hashes, model names, token counts, timestamps, device names, and optional project basenames. It does not store prompts, assistant responses, OpenAI credentials, Codex auth files, or full project paths.",
    ""
  );

  return `${lines.join("\n")}`;
}

function reportRangeLabel(result, options = {}) {
  if (options.periodLabel) return options.periodLabel;
  if (options.year) return String(options.year);
  const range = result.summary?.dateRange;
  const start = compactDate(range?.start);
  const end = compactDate(range?.end);
  if (start && end && start !== end) return `${start} to ${end}`;
  if (start || end) return start || end;
  return "All available data";
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

function formatUsd(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "";
  return `$${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: value >= 1 ? 2 : 4,
    maximumFractionDigits: 4
  }).format(value)}`;
}

function formatTimestamp(value) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function compactDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function escapeMarkdown(value) {
  return String(value || "").replace(/[\\|]/g, "\\$&");
}

function pushWithRetry(worktree, branch) {
  const pushed = git(worktree, ["push", "-u", "origin", branch], { optional: true });
  if (pushed !== null) return true;

  git(worktree, ["pull", "--rebase", "origin", branch], { optional: true });
  const retry = git(worktree, ["push", "-u", "origin", branch], { optional: true });
  if (retry === null) {
    throw new Error("Git sync push failed. Run the command again after checking your private repo access.");
  }
  return true;
}

function sessionToRecord(session, device, options) {
  const project = syncProjectName(session.project);
  return {
    id: hashValue(`session:${session.id}`),
    schemaVersion: SYNC_SCHEMA_VERSION,
    device,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    model: session.model || "unknown",
    effort: session.effort || "",
    source: session.source || "",
    userMessages: session.userMessages || 0,
    tokenEvents: session.tokenEvents || 0,
    projectHash: project ? hashValue(`project:${project}`) : "",
    project: options.syncProjects && project ? project : undefined,
    usage: normalizeStoredUsage(session.usage),
    days: Array.isArray(session.days) ? session.days.map(normalizeDayRecord) : []
  };
}

function syncProjectName(project) {
  const value = String(project || "");
  if (!value || value === "unknown") return "";
  return value.split(/[\\/]+/).filter(Boolean).pop() || "";
}

function mergeRecordsIntoDevice(deviceFile, records) {
  const byId = new Map(deviceFile.sessions.map((record) => [record.id, record]));
  let added = 0;
  let updated = 0;

  for (const record of records) {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      added += 1;
    } else if (stableJson(existing) !== stableJson(record)) {
      byId.set(record.id, { ...existing, ...record });
      updated += 1;
    }
  }

  deviceFile.schemaVersion = SYNC_SCHEMA_VERSION;
  deviceFile.updatedAt = new Date().toISOString();
  deviceFile.sessions = Array.from(byId.values()).sort(compareRecords);
  return { added, updated };
}

function aggregateRecords(records, options) {
  const byId = new Map();
  let duplicateSessions = 0;
  for (const record of records) {
    if (!record?.id || !isRecordInRange(record, options)) continue;
    if (byId.has(record.id)) {
      duplicateSessions += 1;
      continue;
    }
    byId.set(record.id, normalizeRecord(record));
  }

  const sessions = Array.from(byId.values())
    .map((record) => recordView(record, options))
    .filter(Boolean)
    .sort((a, b) => (b.usage.totalTokens || 0) - (a.usage.totalTokens || 0));
  const dayMap = new Map();
  const weekMap = new Map();
  const modelMap = new Map();
  const projectMap = new Map();
  const activeDays = new Set();
  const projects = new Set();
  const models = new Set();
  const devices = new Set();
  const usage = emptyUsage();
  let userMessages = 0;
  let tokenEvents = 0;
  let start = null;
  let end = null;

  for (const session of sessions) {
    addUsage(usage, session.usage);
    userMessages += session.userMessages;
    tokenEvents += session.tokenEvents;
    if (session.device) devices.add(session.device);
    if (session.model) models.add(session.model);
    const projectKey = session.projectHash || session.project || "unknown";
    if (projectKey !== "unknown") projects.add(projectKey);
    const startedAt = parseDate(session.startedAt);
    const lastActivityAt = parseDate(session.lastActivityAt) || startedAt;
    if (startedAt) start = minDate(start, startedAt);
    if (lastActivityAt) end = maxDate(end, lastActivityAt);
    const days = recordDays(session, options);
    const countedWeeks = new Set();
    for (const day of days) {
      activeDays.add(day.date);
      addUsageGroup(dayMap, day.date, day);
      const week = isoWeekKey(day.date);
      addUsageGroup(weekMap, week, {
        ...day,
        sessions: countedWeeks.has(week) ? 0 : day.sessions
      });
      countedWeeks.add(week);
    }
    addGroup(modelMap, session.model || "unknown", session);
    addGroup(projectMap, projectLabel(session), session);
  }

  return {
    summary: {
      codexHome: "synced",
      codexHomes: [],
      sessionsRoot: `git sync (${options.syncSummary?.devices || devices.size} devices)`,
      sessionRoots: [],
      sessions: sessions.length,
      filesScanned: 0,
      duplicateSessions,
      tokenEvents,
      userMessages,
      activeDays: activeDays.size,
      projects: projects.size,
      models: models.size,
      devices: devices.size,
      parseErrors: 0,
      skippedTokenEvents: 0,
      dateRange: start || end ? {
        start: start?.toISOString() || null,
        end: end?.toISOString() || null
      } : null,
      usage,
      sync: options.syncSummary
    },
    groups: {
      day: finalizeGroups(dayMap, "date"),
      week: finalizeGroups(weekMap, "week"),
      model: finalizeGroups(modelMap, "model"),
      project: finalizeGroups(projectMap, "project")
    },
    sessions
  };
}

function readAllDeviceFiles(worktree) {
  const dir = path.join(worktree, DATA_DIR);
  const deviceFiles = new Map();
  if (!fs.existsSync(dir)) return { deviceFiles };

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(dir, entry.name);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed?.device || !Array.isArray(parsed.sessions)) continue;
    deviceFiles.set(parsed.device, {
      schemaVersion: parsed.schemaVersion || SYNC_SCHEMA_VERSION,
      device: parsed.device,
      updatedAt: parsed.updatedAt || null,
      sessions: parsed.sessions.map(normalizeRecord)
    });
  }
  return { deviceFiles };
}

function allRecords(deviceFiles) {
  return Array.from(deviceFiles.values()).flatMap((file) => file.sessions || []);
}

function deviceSyncTimes(deviceFiles) {
  return Array.from(deviceFiles.values())
    .map((file) => ({
      device: file.device,
      updatedAt: file.updatedAt || null,
      sessions: Array.isArray(file.sessions) ? file.sessions.length : 0
    }))
    .sort((left, right) => String(left.device).localeCompare(String(right.device)));
}

function emptyDeviceFile(device) {
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    device,
    updatedAt: null,
    sessions: []
  };
}

function normalizeRecord(record) {
  return {
    id: String(record.id || ""),
    schemaVersion: record.schemaVersion || SYNC_SCHEMA_VERSION,
    device: String(record.device || "unknown-device"),
    startedAt: record.startedAt || null,
    lastActivityAt: record.lastActivityAt || record.startedAt || null,
    model: record.model || "unknown",
    effort: record.effort || "",
    source: record.source || "",
    userMessages: Number(record.userMessages) || 0,
    tokenEvents: Number(record.tokenEvents) || 0,
    projectHash: record.projectHash || "",
    project: record.project || undefined,
    usage: normalizeStoredUsage(record.usage),
    days: Array.isArray(record.days) ? record.days.map(normalizeDayRecord) : []
  };
}

function normalizeStoredUsage(usage = {}) {
  return {
    inputTokens: Number(usage.inputTokens) || 0,
    cachedInputTokens: Number(usage.cachedInputTokens) || 0,
    outputTokens: Number(usage.outputTokens) || 0,
    reasoningOutputTokens: Number(usage.reasoningOutputTokens) || 0,
    totalTokens: Number(usage.totalTokens) || 0
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

function addUsageGroup(map, key, day) {
  if (!key) return;
  const group = map.get(key) || {
    key,
    sessions: 0,
    userMessages: 0,
    tokenEvents: 0,
    usage: emptyUsage()
  };
  group.sessions += day.sessions || 0;
  group.userMessages += day.userMessages || 0;
  group.tokenEvents += day.tokenEvents || 0;
  addUsage(group.usage, day.usage || emptyUsage());
  map.set(key, group);
}

function finalizeGroups(map, keyName) {
  return Array.from(map.values())
    .sort((a, b) => {
      if (keyName === "date" || keyName === "week") return String(a.key).localeCompare(String(b.key));
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

function isRecordInRange(record, options) {
  const date = parseDate(record.startedAt || record.lastActivityAt);
  if (!date) return true;
  if (Array.isArray(record.days) && record.days.some((day) => dayKeyInRange(day.date, options))) return true;
  return timestampInRange(date, options);
}

function syncWorktree(repoUrl, syncCache) {
  if (syncCache) return path.resolve(expandHome(syncCache));
  return path.join(os.homedir(), ".codex-info", "sync", hashValue(repoUrl).slice(0, 16));
}

function git(cwd, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: options.commitEnv ? commitEnv() : process.env
    });
  } catch (error) {
    if (options.optional) return null;
    const stderr = error.stderr?.toString()?.trim();
    throw new Error(stderr || `git ${args.join(" ")} failed`);
  }
}

function hasGitChanges(worktree) {
  return Boolean(git(worktree, ["status", "--porcelain"], { optional: true })?.trim());
}

function commitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "codex-info",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "codex-info@local",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "codex-info",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "codex-info@local"
  };
}

function safeDeviceName(value) {
  const name = String(value || "unknown-device")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name || "unknown-device";
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(sortObject(value), null, 2);
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortObject(child)])
  );
}

function compareRecords(left, right) {
  return String(left.startedAt || "").localeCompare(String(right.startedAt || ""))
    || String(left.id).localeCompare(String(right.id));
}

function projectLabel(session) {
  if (session.project) return session.project;
  if (session.projectHash) return `project:${session.projectHash.slice(0, 8)}`;
  return "unknown";
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function minDate(left, right) {
  if (!left) return right;
  return right < left ? right : left;
}

function maxDate(left, right) {
  if (!left) return right;
  return right > left ? right : left;
}

function expandHome(value) {
  if (!value || value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function normalizeDayRecord(day) {
  return {
    date: String(day.date || ""),
    sessions: Number(day.sessions) || 0,
    userMessages: Number(day.userMessages) || 0,
    tokenEvents: Number(day.tokenEvents) || 0,
    usage: normalizeStoredUsage(day.usage)
  };
}

function recordDays(record, options) {
  if (Array.isArray(record.days) && record.days.length) {
    return record.days
      .map(normalizeDayRecord)
      .filter((day) => dayKeyInRange(day.date, options));
  }

  const date = localDateKey(record.lastActivityAt || record.startedAt);
  if (!date || !dayKeyInRange(date, options)) return [];
  return [{
    date,
    sessions: 1,
    userMessages: record.userMessages || 0,
    tokenEvents: record.tokenEvents || 0,
    usage: normalizeStoredUsage(record.usage)
  }];
}

function recordView(record, options) {
  const days = recordDays(record, options);
  if (!days.length) return null;
  const usage = emptyUsage();
  let userMessages = 0;
  let tokenEvents = 0;
  for (const day of days) {
    addUsage(usage, day.usage);
    userMessages += day.userMessages;
    tokenEvents += day.tokenEvents;
  }
  return {
    ...record,
    userMessages,
    tokenEvents,
    usage,
    days
  };
}
