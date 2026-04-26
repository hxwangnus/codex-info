#!/usr/bin/env node
import { collectUsage, defaultCodexHome } from "./usage.js";
import { renderBriefReport, renderJson, renderTextReport, writeHtmlReport } from "./format.js";
import { enrichWithOnlineMetadata } from "./metadata.js";
import { syncGitUsage } from "./sync-git.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }

  let result = await collectUsage(options);
  if (options.syncGit) {
    result = await syncGitUsage(result, options);
  }
  if (options.onlineMetadata) {
    await enrichWithOnlineMetadata(result, options);
  }

  if (options.json) {
    process.stdout.write(`${renderJson(result)}\n`);
  } else if (options.brief) {
    process.stdout.write(`${renderBriefReport(result, options)}\n`);
  } else {
    process.stdout.write(`${renderTextReport(result, options)}\n`);
  }

  if (options.html) {
    const output = await writeHtmlReport(result, options.html, options);
    process.stdout.write(`\nHTML report written to ${output}\n`);
  }
}

function parseArgs(argv) {
  const options = {
    codexHomes: [],
    groupBy: "day",
    limit: 12,
    topSessions: 5,
    topModels: 2,
    brief: false,
    includeProjectPaths: false,
    includeFiles: false,
    includeArchived: false,
    onlineMetadata: false,
    pricingTier: "standard",
    syncGit: "",
    syncBranch: "main",
    syncCache: "",
    syncDevice: "",
    syncProjects: false,
    color: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "--codex-home") {
      options.codexHomes.push(requiredValue(argv, ++index, arg));
    } else if (arg === "--year") {
      options.year = requiredValue(argv, ++index, arg);
    } else if (arg === "--since") {
      options.since = requiredValue(argv, ++index, arg);
    } else if (arg === "--until") {
      options.until = requiredValue(argv, ++index, arg);
    } else if (arg === "--group-by") {
      options.groupBy = oneOf(requiredValue(argv, ++index, arg), ["day", "model", "project"], arg);
    } else if (arg === "--limit") {
      options.limit = positiveInt(requiredValue(argv, ++index, arg), arg);
    } else if (arg === "--top-sessions") {
      options.topSessions = positiveInt(requiredValue(argv, ++index, arg), arg);
    } else if (arg === "--top-models") {
      options.topModels = positiveInt(requiredValue(argv, ++index, arg), arg);
    } else if (arg === "--html") {
      options.html = requiredValue(argv, ++index, arg);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--brief" || arg === "--compact") {
      options.brief = true;
    } else if (arg === "--online-metadata" || arg === "--cost") {
      options.onlineMetadata = true;
    } else if (arg === "--pricing-tier") {
      options.pricingTier = oneOf(requiredValue(argv, ++index, arg), ["standard", "batch", "flex", "priority"], arg);
    } else if (arg === "--sync-git") {
      options.syncGit = requiredValue(argv, ++index, arg);
    } else if (arg === "--sync-branch") {
      options.syncBranch = requiredValue(argv, ++index, arg);
    } else if (arg === "--sync-cache") {
      options.syncCache = requiredValue(argv, ++index, arg);
    } else if (arg === "--device") {
      options.syncDevice = requiredValue(argv, ++index, arg);
    } else if (arg === "--sync-projects") {
      options.syncProjects = true;
    } else if (arg === "--include-archived") {
      options.includeArchived = true;
    } else if (arg === "--include-project-paths") {
      options.includeProjectPaths = true;
    } else if (arg === "--include-files") {
      options.includeFiles = true;
    } else if (arg === "--no-color") {
      options.color = false;
    } else if (/^\d{4}$/.test(arg) && !options.year) {
      options.year = arg;
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${helpText()}`);
    }
  }

  if (!options.codexHomes.length) options.codexHomes.push(defaultCodexHome());
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

function positiveInt(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${flag} must be a non-negative integer`);
  return number;
}

function helpText() {
  return `codex-info

Local-only Codex token usage reporter.

Usage:
  npm start -- [options]
  npx . [year] [options]

Options:
  --codex-home <path>        Codex state directory; repeat to merge machines
  --year <yyyy>              Only scan sessions/<year>
  --since <yyyy-mm-dd>       Include sessions starting on/after this UTC date
  --until <yyyy-mm-dd>       Include sessions starting on/before this UTC date
  --group-by <kind>          day, model, or project (default: day)
  --limit <n>                Rows to show in grouped table (default: 12)
  --top-sessions <n>         Sessions to show in terminal/HTML report (default: 5)
  --top-models <n>           Models to show in --brief output (default: 2)
  --brief, --compact         Print a short wrapped-style report
  --json                     Print machine-readable JSON
  --html <file>              Write a self-contained local HTML report
  --cost, --online-metadata  Fetch public model/pricing metadata and estimate cost
  --pricing-tier <tier>      standard, batch, flex, or priority (default: standard)
  --sync-git <repo-url>      Sync usage through your private Git repository
  --device <name>            Device name for --sync-git (default: hostname)
  --sync-branch <branch>     Git sync branch (default: main)
  --sync-cache <path>        Local sync clone cache (default: ~/.codex-info/sync/...)
  --sync-projects            Upload project basenames to the private sync repo
  --include-archived         Include archived_sessions/*.jsonl
  --include-project-paths    Show full project paths instead of basenames
  --include-files            Include session JSONL paths in JSON output
  --no-color                 Disable ANSI colors
  -h, --help                 Show this help

Privacy:
  Reads sessions/**/*.jsonl from each --codex-home, and archived_sessions/*.jsonl only with --include-archived.
  Does not read auth.json, config.toml, history.jsonl, or logs.
  Makes no network requests unless --online-metadata/--cost or --sync-git is set.
  Cost uses OpenAI official pricing docs when available, falling back to a public pricing table.
  Online metadata requests use fixed public URLs and send no local usage data.
  Git sync uploads hashed session ids, token counts, model, time, and device name.
  Project names are not uploaded unless --sync-projects is set.
`;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
