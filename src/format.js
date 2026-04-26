import fs from "node:fs";
import path from "node:path";
import { addDays, localDateKey, startOfLocalIsoWeek } from "./date-utils.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";

export function renderTextReport(result, options = {}) {
  const color = options.color !== false && process.stdout.isTTY;
  const lines = [];
  const title = "Codex Local Usage";
  lines.push(color ? `${BOLD}${title}${RESET}` : title);
  lines.push(`${dim("Data", color)} ${dataRootLabel(result.summary)}`);
  lines.push(`${dim("Privacy", color)} read-only; auth.json/logs ignored; ${result.metadata?.online ? "metadata fetched from fixed public URLs" : "no network calls"}`);
  lines.push("");

  lines.push(`${green("Summary", color)}`);
  lines.push(table([
    ["Sessions", formatInt(result.summary.sessions)],
    ["User messages", formatInt(result.summary.userMessages)],
    ["Active days", formatInt(result.summary.activeDays)],
    ["Projects", formatInt(result.summary.projects)],
    ["Models", formatInt(result.summary.models)],
    ["Token events", formatInt(result.summary.tokenEvents)],
    ["Total tokens", formatInt(result.summary.usage.totalTokens)],
    ["Input tokens", formatInt(result.summary.usage.inputTokens)],
    ["Cached input", formatInt(result.summary.usage.cachedInputTokens)],
    ["Output tokens", formatInt(result.summary.usage.outputTokens)],
    ["Reasoning output", formatInt(result.summary.usage.reasoningOutputTokens)],
    ...(typeof result.summary.estimatedCostUSD === "number"
      ? [["Est. cost", formatUsd(result.summary.estimatedCostUSD)]]
      : [])
  ], { header: false }));

  if (result.summary.dateRange) {
    lines.push(`${dim("Range", color)} ${compactDate(result.summary.dateRange.start)} to ${compactDate(result.summary.dateRange.end)}`);
  }
  if (result.summary.parseErrors || result.summary.skippedTokenEvents) {
    lines.push(`${dim("Notes", color)} parse errors: ${result.summary.parseErrors}; skipped token events: ${result.summary.skippedTokenEvents}`);
  }
  if (result.summary.duplicateSessions) {
    lines.push(`${dim("Duplicates", color)} skipped ${result.summary.duplicateSessions} duplicate session id(s)`);
  }
  if (result.summary.sync) {
    const sync = result.summary.sync;
    lines.push(`${dim("Sync", color)} ${sync.devices} device(s), ${sync.addedSessions} added, ${sync.updatedSessions} updated${sync.pushed ? ", pushed" : ""}`);
  }
  if (result.metadata?.errors?.length) {
    lines.push(`${dim("Metadata", color)} ${result.metadata.errors.join("; ")}`);
  }
  if (options.periodLabel) {
    lines.push(`${dim("Period", color)} ${options.periodLabel}`);
  }

  lines.push("");
  lines.push(`${green(groupTitle(options.groupBy), color)}`);
  lines.push(renderGroupTable(result, options));

  if (options.heatmap) {
    lines.push("");
    lines.push(renderHeatmap(result, options));
  }

  if (options.topSessions > 0) {
    lines.push("");
    lines.push(`${green("Top Sessions", color)}`);
    lines.push(renderSessionsTable(result.sessions.slice(0, options.topSessions)));
  }

  return lines.join("\n");
}

export function renderBriefReport(result, options = {}) {
  const year = reportYear(result, options);
  const lines = [];
  lines.push(`Codex-Info Report ${year}`);
  lines.push("");
  lines.push(labelLine("Sessions", result.summary.sessions));
  lines.push(labelLine("User messages", result.summary.userMessages));
  lines.push(labelLine("Active days", result.summary.activeDays));
  lines.push(labelLine("Projects", result.summary.projects));
  lines.push("");
  lines.push("Tokens:");
  lines.push(tokenLine("input", result.summary.usage.inputTokens));
  lines.push(tokenLine("cached input", result.summary.usage.cachedInputTokens));
  lines.push(tokenLine("output", result.summary.usage.outputTokens));
  lines.push(tokenLine("reasoning", result.summary.usage.reasoningOutputTokens));
  lines.push(tokenLine("total", result.summary.usage.totalTokens));
  if (typeof result.summary.estimatedCostUSD === "number") {
    lines.push("");
    lines.push("Cost:");
    lines.push(valueLine("estimated", formatUsd(result.summary.estimatedCostUSD)));
    lines.push(`  source:          ${pricingSourceLabel(result)}`);
  }
  lines.push("");
  lines.push("Top models:");

  const topModels = result.groups.model.slice(0, options.topModels ?? 2);
  if (!topModels.length) {
    lines.push("  none");
  } else {
    const modelWidth = Math.max(...topModels.map((row) => row.model.length), 1);
    for (const row of topModels) {
      const cost = typeof row.estimatedCostUSD === "number" ? `  ${formatUsd(row.estimatedCostUSD)}` : "";
      lines.push(`  ${row.model.padEnd(modelWidth)}  ${formatInt(row.usage.totalTokens)} tokens${cost}`);
    }
  }

  if (options.heatmap) {
    lines.push("");
    lines.push(renderHeatmap(result, options));
  }

  return lines.join("\n");
}

export function renderJson(result) {
  return JSON.stringify(result, null, 2);
}

export async function writeHtmlReport(result, outputPath, options = {}) {
  const html = renderHtmlReport(result, options);
  const fullPath = path.resolve(outputPath);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, html, "utf8");
  return fullPath;
}

export function renderHtmlReport(result, options = {}) {
  const groupBy = options.groupBy || "day";
  const groups = groupRows(result, groupBy, options.limit || 20);
  const maxTokens = Math.max(1, ...groups.map((row) => row.usage.totalTokens));
  const showGroupCost = groups.some((row) => typeof row.estimatedCostUSD === "number");
  const generatedAt = new Date().toISOString();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Local Usage</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f7f2;
      --text: #1f2933;
      --muted: #65717e;
      --line: #d8ddd3;
      --panel: #ffffff;
      --accent: #2f6f73;
      --accent-2: #bb6b33;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #151817;
        --text: #edf0ec;
        --muted: #a8b0aa;
        --line: #343b37;
        --panel: #1f2422;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1080px, calc(100vw - 32px));
      margin: 28px auto 40px;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: end;
      border-bottom: 1px solid var(--line);
      padding-bottom: 18px;
      margin-bottom: 22px;
    }
    h1 {
      margin: 0;
      font-size: 28px;
      letter-spacing: 0;
    }
    .meta {
      color: var(--muted);
      text-align: right;
      overflow-wrap: anywhere;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 22px;
    }
    .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-height: 86px;
    }
    .metric .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }
    .metric .value {
      font-size: 24px;
      font-weight: 700;
      margin-top: 6px;
      overflow-wrap: anywhere;
    }
    section {
      margin-top: 26px;
    }
    h2 {
      margin: 0 0 10px;
      font-size: 18px;
      letter-spacing: 0;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      text-align: right;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      white-space: nowrap;
    }
    th:first-child, td:first-child {
      text-align: left;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    tr:last-child td { border-bottom: 0; }
    th {
      color: var(--muted);
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
    }
    .bar-cell {
      min-width: 150px;
    }
    .bar {
      height: 10px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      overflow: hidden;
    }
    .bar span {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      border-radius: inherit;
    }
    footer {
      color: var(--muted);
      margin-top: 22px;
      font-size: 12px;
    }
    @media (max-width: 720px) {
      main { width: min(100vw - 20px, 1080px); margin-top: 18px; }
      header { display: block; }
      .meta { text-align: left; margin-top: 8px; }
      th:nth-child(3), td:nth-child(3),
      th:nth-child(4), td:nth-child(4),
      th:nth-child(5), td:nth-child(5) { display: none; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Codex Local Usage</h1>
        <div class="meta">Read-only local report. ${result.metadata?.online ? "Fetched public metadata from fixed URLs." : "No network calls."} auth.json and logs are ignored.</div>
      </div>
      <div class="meta">${escapeHtml(dataRootLabel(result.summary))}<br>${escapeHtml(compactDate(result.summary.dateRange?.start))} to ${escapeHtml(compactDate(result.summary.dateRange?.end))}</div>
    </header>

    <div class="grid">
      ${metric("Total tokens", formatInt(result.summary.usage.totalTokens))}
      ${typeof result.summary.estimatedCostUSD === "number" ? metric("Est. cost", formatUsd(result.summary.estimatedCostUSD)) : ""}
      ${metric("Sessions", formatInt(result.summary.sessions))}
      ${metric("User messages", formatInt(result.summary.userMessages))}
      ${metric("Active days", formatInt(result.summary.activeDays))}
      ${metric("Projects", formatInt(result.summary.projects))}
      ${metric("Models", formatInt(result.summary.models))}
    </div>

    <section>
      <h2>${escapeHtml(groupTitle(groupBy))}</h2>
      <table>
        <thead>
          <tr>
            <th>${escapeHtml(groupBy)}</th>
            <th>Total</th>
            <th>Input</th>
            <th>Cached</th>
            <th>Output</th>
            <th>Sessions</th>
            ${showGroupCost ? "<th>Est. cost</th>" : ""}
            <th class="bar-cell">Share</th>
          </tr>
        </thead>
        <tbody>
          ${groups.map((row) => groupHtml(row, maxTokens, groupBy, showGroupCost)).join("\n")}
        </tbody>
      </table>
    </section>

    ${htmlTopSessions(result, options)}
    <footer>Generated at ${escapeHtml(generatedAt)} from local Codex session JSONL files.</footer>
  </main>
</body>
</html>`;
}

function htmlTopSessions(result, options) {
  const limit = options.topSessions ?? 10;
  if (limit <= 0) return "";
  return `<section>
      <h2>Top Sessions</h2>
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Model</th>
            <th>Project</th>
            <th>Total</th>
            <th>Messages</th>
          </tr>
        </thead>
        <tbody>
          ${result.sessions.slice(0, limit).map(sessionHtml).join("\n")}
        </tbody>
      </table>
    </section>`;
}

function renderGroupTable(result, options) {
  const groupBy = options.groupBy || "day";
  const rows = groupRows(result, groupBy, options.limit || 12);
  const label = groupBy === "day" ? "Date" : groupBy === "week" ? "Week" : groupBy === "model" ? "Model" : "Project";
  const showCost = rows.some((row) => typeof row.estimatedCostUSD === "number");
  return table([
    [label, "Total", "Input", "Cached", "Output", "Sessions", ...(showCost ? ["Est. cost"] : [])],
    ...rows.map((row) => [
      row[groupBy],
      formatInt(row.usage.totalTokens),
      formatInt(row.usage.inputTokens),
      formatInt(row.usage.cachedInputTokens),
      formatInt(row.usage.outputTokens),
      formatInt(row.sessions),
      ...(showCost ? [typeof row.estimatedCostUSD === "number" ? formatUsd(row.estimatedCostUSD) : "n/a"] : [])
    ])
  ]);
}

function renderSessionsTable(sessions) {
  return table([
    ["Started", "Model", "Project", "Total", "Messages"],
    ...sessions.map((session) => [
      compactDate(session.startedAt),
      session.model,
      session.project,
      formatInt(session.usage.totalTokens),
      formatInt(session.userMessages)
    ])
  ]);
}

function table(rows, options = {}) {
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] || 0, stripAnsi(String(cell)).length);
    });
  }
  return rows
    .map((row, rowIndex) => {
      const line = row
        .map((cell, index) => {
          const text = String(cell);
          const pad = " ".repeat(Math.max(0, widths[index] - stripAnsi(text).length));
          return index === 0 ? `${text}${pad}` : `${pad}${text}`;
        })
        .join("  ");
      if (rowIndex === 0 && options.header !== false) return line;
      return line;
    })
    .join("\n");
}

function groupRows(result, groupBy, limit) {
  const key = groupBy === "model" ? "model" : groupBy === "project" ? "project" : groupBy === "week" ? "week" : "date";
  const rows = result.groups[groupBy] || result.groups.day;
  return rows
    .map((row) => ({
      ...row,
      [groupBy]: row[key]
    }))
    .slice(0, limit);
}

function groupTitle(groupBy = "day") {
  if (groupBy === "week") return "Usage by Week";
  if (groupBy === "model") return "Usage by Model";
  if (groupBy === "project") return "Usage by Project";
  return "Usage by Day";
}

function groupHtml(row, maxTokens, groupBy, showCost = false) {
  const width = Math.max(2, Math.round((row.usage.totalTokens / maxTokens) * 100));
  return `<tr>
    <td>${escapeHtml(row[groupBy])}</td>
    <td>${formatInt(row.usage.totalTokens)}</td>
    <td>${formatInt(row.usage.inputTokens)}</td>
    <td>${formatInt(row.usage.cachedInputTokens)}</td>
    <td>${formatInt(row.usage.outputTokens)}</td>
    <td>${formatInt(row.sessions)}</td>
    ${showCost ? `<td>${typeof row.estimatedCostUSD === "number" ? formatUsd(row.estimatedCostUSD) : "n/a"}</td>` : ""}
    <td class="bar-cell"><div class="bar"><span style="width:${width}%"></span></div></td>
  </tr>`;
}

function sessionHtml(session) {
  return `<tr>
    <td>${escapeHtml(compactDate(session.startedAt))}</td>
    <td>${escapeHtml(session.model)}</td>
    <td>${escapeHtml(session.project)}</td>
    <td>${formatInt(session.usage.totalTokens)}</td>
    <td>${formatInt(session.userMessages)}</td>
  </tr>`;
}

function metric(label, value) {
  return `<div class="metric"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}

function compactDate(value) {
  if (!value) return "n/a";
  return String(value).replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function formatInt(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function labelLine(label, value) {
  return `${`${label}:`.padEnd(16)}${formatInt(value).padStart(10)}`;
}

function tokenLine(label, value) {
  return `  ${`${label}:`.padEnd(16)}${formatInt(value).padStart(12)}`;
}

function valueLine(label, value) {
  return `  ${`${label}:`.padEnd(16)}${String(value).padStart(12)}`;
}

function reportYear(result, options) {
  if (options.periodLabel) return options.periodLabel;
  if (options.year) return options.year;
  const startYear = result.summary.dateRange?.start?.slice(0, 4);
  const endYear = result.summary.dateRange?.end?.slice(0, 4);
  if (startYear && startYear === endYear) return startYear;
  return "All Time";
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 4 : 2
  }).format(value || 0);
}

function pricingSourceLabel(result) {
  const source = result.summary.pricingSource === "openai" ? "OpenAI official pricing" : "fallback pricing";
  const tier = result.summary.pricingTier || "standard";
  const priced = typeof result.summary.pricedModels === "number" && typeof result.summary.models === "number"
    ? `, ${result.summary.pricedModels}/${result.summary.models} models priced`
    : "";
  return `${source}, ${tier}${priced}`;
}

function renderHeatmap(result, options = {}) {
  const year = Number(options.year || result.summary.dateRange?.start?.slice(0, 4) || new Date().getFullYear());
  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  const gridStart = startOfLocalIsoWeek(start);
  const gridEnd = addDays(startOfLocalIsoWeek(addDays(end, 6)), 6);
  const dayTotals = new Map((result.groups.day || []).map((row) => [row.date, row.usage.totalTokens || 0]));
  const max = Math.max(0, ...dayTotals.values());
  const weeks = Math.ceil((gridEnd - gridStart) / 86400000 / 7) + 1;
  const lines = [];

  lines.push(`Usage Heatmap ${year} (tokens/day)`);
  lines.push(monthHeader(gridStart, weeks));

  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  for (let row = 0; row < 7; row += 1) {
    let line = `${dayLabels[row]}  `;
    for (let col = 0; col < weeks; col += 1) {
      const date = addDays(gridStart, col * 7 + row);
      const inYear = date >= start && date <= end;
      const value = inYear ? dayTotals.get(localDateKey(date)) || 0 : 0;
      line += `${inYear ? heatChar(value, max) : " "} `;
    }
    lines.push(line.trimEnd());
  }

  lines.push(`Legend: . 0  ░ low  ▒ medium  ▓ high  █ peak`);
  return lines.join("\n");
}

function monthHeader(gridStart, weeks) {
  const width = weeks * 2;
  const chars = Array(width).fill(" ");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const year = addDays(gridStart, 10).getFullYear();
  for (let month = 0; month < 12; month += 1) {
    const first = new Date(year, month, 1);
    const col = Math.max(0, Math.floor((startOfLocalIsoWeek(first) - gridStart) / 86400000 / 7) * 2);
    const label = monthNames[month];
    for (let index = 0; index < label.length && col + index < width; index += 1) {
      chars[col + index] = label[index];
    }
  }
  return `     ${chars.join("")}`.trimEnd();
}

function heatChar(value, max) {
  if (!value || max <= 0) return ".";
  const ratio = value / max;
  if (ratio < 0.25) return "░";
  if (ratio < 0.5) return "▒";
  if (ratio < 0.75) return "▓";
  return "█";
}

function dataRootLabel(summary) {
  const roots = summary.sessionRoots || (summary.sessionsRoot ? [summary.sessionsRoot] : []);
  if (roots.length <= 1) return roots[0] || "n/a";
  return `${roots.length} Codex homes: ${roots.join(", ")}`;
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function dim(value, color) {
  return color ? `${DIM}${value}${RESET}` : value;
}

function green(value, color) {
  return color ? `${GREEN}${value}${RESET}` : value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
