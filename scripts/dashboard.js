#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { collectUsage, defaultCodexHome } from "../src/usage.js";
import { renderBriefReport, writeHtmlReport } from "../src/format.js";
import { writeHeatmapPng } from "../src/heatmap-png.js";
import { enrichWithOnlineMetadata } from "../src/metadata.js";
import { syncGitUsage, updateSyncReadme } from "../src/sync-git.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  const reportDir = path.resolve(expandHome(options.outputDir));
  const htmlPath = path.join(reportDir, `codex-dashboard-${options.year}.html`);
  const pngPath = path.join(reportDir, `codex-heatmap-${options.year}.png`);

  const usageOptions = {
    codexHomes: options.codexHomes.length ? options.codexHomes : [defaultCodexHome()],
    year: options.year,
    groupBy: "day",
    limit: 366,
    topSessions: 0,
    topModels: 5,
    onlineMetadata: options.cost,
    pricingTier: options.pricingTier,
    syncGit: options.syncGit,
    syncBranch: options.syncBranch,
    syncCache: options.syncCache,
    syncDevice: options.device,
    syncReadme: options.syncReadme,
    syncProjects: options.syncProjects,
    color: false
  };

  let result = await collectUsage(usageOptions);
  if (usageOptions.syncGit) result = await syncGitUsage(result, usageOptions);
  if (usageOptions.onlineMetadata) await enrichWithOnlineMetadata(result, usageOptions);
  if (usageOptions.syncGit && usageOptions.syncReadme) {
    const readmeSync = await updateSyncReadme(result, usageOptions);
    result.summary.sync = { ...result.summary.sync, readme: readmeSync };
  }

  await fs.promises.mkdir(reportDir, { recursive: true });
  await writeHeatmapPng(result, pngPath, usageOptions);
  await writeHtmlReport(result, htmlPath, {
    ...usageOptions,
    heatmapImage: path.basename(pngPath)
  });

  process.stdout.write(`${renderBriefReport(result, usageOptions)}\n\n`);
  process.stdout.write(`Dashboard written to ${htmlPath}\n`);
  process.stdout.write(`PNG heatmap written to ${pngPath}\n`);

  if (options.open !== "none") {
    const target = options.open === "png" ? pngPath : htmlPath;
    openFile(target);
  }
}

function parseArgs(argv) {
  const options = {
    year: String(new Date().getFullYear()),
    outputDir: process.env.CODEX_INFO_DASHBOARD_DIR || path.join(os.homedir(), ".codex-info", "dashboard"),
    syncGit: process.env.CODEX_INFO_SYNC_GIT || "",
    syncBranch: process.env.CODEX_INFO_SYNC_BRANCH || "main",
    syncCache: process.env.CODEX_INFO_SYNC_CACHE || "",
    device: process.env.CODEX_INFO_DEVICE || os.hostname(),
    pricingTier: process.env.CODEX_INFO_PRICING_TIER || "standard",
    cost: process.env.CODEX_INFO_COST !== "0",
    syncReadme: process.env.CODEX_INFO_SYNC_README !== "0",
    syncProjects: process.env.CODEX_INFO_SYNC_PROJECTS === "1",
    open: process.env.CODEX_INFO_OPEN || "html",
    codexHomes: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (/^\d{4}$/.test(arg)) {
      options.year = arg;
    } else if (arg === "--year") {
      options.year = requiredValue(argv, ++index, arg);
    } else if (arg === "--sync-git") {
      options.syncGit = requiredValue(argv, ++index, arg);
    } else if (arg === "--sync-branch") {
      options.syncBranch = requiredValue(argv, ++index, arg);
    } else if (arg === "--sync-cache") {
      options.syncCache = requiredValue(argv, ++index, arg);
    } else if (arg === "--device") {
      options.device = requiredValue(argv, ++index, arg);
    } else if (arg === "--output-dir") {
      options.outputDir = requiredValue(argv, ++index, arg);
    } else if (arg === "--open") {
      options.open = oneOf(requiredValue(argv, ++index, arg), ["html", "png", "none"], arg);
    } else if (arg === "--pricing-tier") {
      options.pricingTier = oneOf(requiredValue(argv, ++index, arg), ["standard", "batch", "flex", "priority"], arg);
    } else if (arg === "--codex-home") {
      options.codexHomes.push(requiredValue(argv, ++index, arg));
    } else if (arg === "--no-cost") {
      options.cost = false;
    } else if (arg === "--no-sync-readme") {
      options.syncReadme = false;
    } else if (arg === "--sync-projects") {
      options.syncProjects = true;
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${helpText()}`);
    }
  }

  return options;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function oneOf(value, allowed, flag) {
  if (!allowed.includes(value)) throw new Error(`${flag} must be one of: ${allowed.join(", ")}`);
  return value;
}

function openFile(file) {
  const fullPath = path.resolve(file);
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", fullPath], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [fullPath], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (isWsl()) {
    const windowsPath = execFileSync("wslpath", ["-w", fullPath], { encoding: "utf8" }).trim();
    spawn("cmd.exe", ["/c", "start", "", windowsPath], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [fullPath], { detached: true, stdio: "ignore" }).unref();
}

function isWsl() {
  try {
    return fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function expandHome(value) {
  if (!value || value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function helpText() {
  return `codex-info dashboard

Generate a local HTML dashboard and PNG heatmap, then open it.

Usage:
  npm run dashboard -- 2026 --sync-git git@github.com:YOU/codex-info-sync.git --device laptop
  node scripts/dashboard.js [year] [options]

Options:
  --sync-git <repo-url>      Private sync repo
  --device <name>            Device name
  --output-dir <path>        Dashboard output directory (default: ~/.codex-info/dashboard)
  --open <html|png|none>     What to open after generation (default: html)
  --pricing-tier <tier>      standard, batch, flex, or priority
  --no-cost                  Skip online pricing metadata
  --no-sync-readme           Do not update private sync repo README/PNG
  --codex-home <path>        Codex state directory; repeat to merge local folders
`;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
