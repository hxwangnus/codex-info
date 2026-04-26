#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  if (!options.syncGit) {
    throw new Error("--sync-git is required, or set CODEX_INFO_SYNC_GIT");
  }

  const launcherDir = path.join(repoRoot, "launchers");
  await fs.promises.mkdir(launcherDir, { recursive: true });

  const written = [];
  const targets = options.target === "all" ? ["unix", "wsl"] : [options.target];
  for (const target of targets) {
    if (target === "wsl") {
      const file = path.join(launcherDir, "codex-info-dashboard.local.cmd");
      await fs.promises.writeFile(file, windowsWslLauncher(options), "utf8");
      written.push(file);
    } else if (target === "windows") {
      const file = path.join(launcherDir, "codex-info-dashboard.local.cmd");
      await fs.promises.writeFile(file, windowsNativeLauncher(options), "utf8");
      written.push(file);
    } else if (target === "macos") {
      const file = path.join(launcherDir, "codex-info-dashboard.local.command");
      await fs.promises.writeFile(file, unixLauncher(options), "utf8");
      await fs.promises.chmod(file, 0o755);
      written.push(file);
    } else {
      const file = path.join(launcherDir, "codex-info-dashboard.local.sh");
      await fs.promises.writeFile(file, unixLauncher(options), "utf8");
      await fs.promises.chmod(file, 0o755);
      written.push(file);
    }
  }

  process.stdout.write(`Created launcher${written.length === 1 ? "" : "s"}:\n`);
  for (const file of written) process.stdout.write(`  ${file}\n`);
}

function parseArgs(argv) {
  const options = {
    year: String(new Date().getFullYear()),
    syncGit: process.env.CODEX_INFO_SYNC_GIT || "",
    device: process.env.CODEX_INFO_DEVICE || os.hostname(),
    open: process.env.CODEX_INFO_OPEN || "html",
    target: defaultTarget()
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
    } else if (arg === "--device") {
      options.device = requiredValue(argv, ++index, arg);
    } else if (arg === "--open") {
      options.open = oneOf(requiredValue(argv, ++index, arg), ["html", "png", "none"], arg);
    } else if (arg === "--target") {
      options.target = oneOf(requiredValue(argv, ++index, arg), ["wsl", "windows", "macos", "unix", "all"], arg);
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${helpText()}`);
    }
  }

  return options;
}

function dashboardArgs(options, separator = " ") {
  return [
    options.year,
    "--sync-git", options.syncGit,
    "--device", options.device,
    "--open", options.open
  ].map((value) => shellQuote(value)).join(separator);
}

function unixLauncher(options) {
  return `#!/usr/bin/env bash
set -euo pipefail

cd ${shellQuote(repoRoot)}
node scripts/dashboard.js ${dashboardArgs(options)}

printf '\\nDashboard updated. Press Enter to close...'
read -r _
`;
}

function windowsWslLauncher(options) {
  const dashboardOptions = { ...options, open: "none" };
  const command = `cd ${shellQuote(repoRoot)} && node scripts/dashboard.js ${dashboardArgs(dashboardOptions)}`;
  const target = options.open === "png" ? dashboardPngPath(options) : dashboardHtmlPath(options);
  return `@echo off
setlocal
set "LOG=%USERPROFILE%\\Desktop\\Codex Info Dashboard.log"
echo [%DATE% %TIME%] Updating Codex Info dashboard... > "%LOG%"
wsl.exe -e bash -lc "${escapeForCmdDoubleQuote(command)}" >> "%LOG%" 2>&1
if errorlevel 1 (
  type "%LOG%"
  echo.
  echo Dashboard update failed. The log is at "%LOG%".
  pause
  exit /b 1
)
${options.open === "none" ? "" : `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '${escapeForPowerShellSingleQuoted(target)}'" >> "%LOG%" 2>&1
if errorlevel 1 (
  type "%LOG%"
  echo.
  echo Dashboard was generated, but Windows could not open it. The log is at "%LOG%".
  pause
  exit /b 1
)`}
exit /b 0
`;
}

function windowsNativeLauncher(options) {
  return `@echo off
setlocal
cd /d "${repoRoot.replaceAll("/", "\\")}"
node scripts\\dashboard.js ${[
    options.year,
    "--sync-git", options.syncGit,
    "--device", options.device,
    "--open", options.open
  ].map((value) => `"${String(value).replaceAll('"', '\\"')}"`).join(" ")}
if errorlevel 1 pause
`;
}

function defaultTarget() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return isWsl() ? "wsl" : "unix";
}

function isWsl() {
  try {
    return fs.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function dashboardHtmlPath(options) {
  return windowsPathFromWslPath(path.join(os.homedir(), ".codex-info", "dashboard", `codex-dashboard-${options.year}.html`));
}

function dashboardPngPath(options) {
  return windowsPathFromWslPath(path.join(os.homedir(), ".codex-info", "dashboard", `codex-heatmap-${options.year}.png`));
}

function windowsPathFromWslPath(value) {
  try {
    return execFileSync("wslpath", ["-w", value], { encoding: "utf8" }).trim();
  } catch {
    const distro = process.env.WSL_DISTRO_NAME || "Ubuntu";
    return `\\\\wsl.localhost\\${distro}${value.replaceAll("/", "\\")}`;
  }
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function escapeForCmdDoubleQuote(value) {
  return value.replaceAll("%", "%%").replaceAll('"', '\\"');
}

function escapeForPowerShellSingleQuoted(value) {
  return String(value).replaceAll("'", "''");
}

function helpText() {
  return `codex-info launcher creator

Creates local double-click launchers. Generated files are ignored by git.

Usage:
  npm run create-launcher -- --sync-git git@github.com:YOU/codex-info-sync.git --device laptop --year 2026

Options:
  --sync-git <repo-url>      Private sync repo
  --device <name>            Device name
  --year <yyyy>              Report year
  --open <html|png|none>     What the dashboard opens
  --target <kind>            wsl, windows, macos, unix, or all
`;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
