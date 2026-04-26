# codex-info

Local-only Codex token usage reporter. It reads Codex session JSONL files from your machine, aggregates token usage, and prints a terminal report or writes a static HTML file.

## Privacy posture

- Reads `sessions/**/*.jsonl` under `CODEX_HOME` or `~/.codex`; pass `--codex-home` multiple times to merge machines.
- `archived_sessions/*.jsonl` is included only with `--include-archived`.
- Does not read `auth.json`, `config.toml`, `history.jsonl`, or `logs`.
- Makes no network requests by default.
- With `--cost` or `--online-metadata`, fetches OpenAI official pricing metadata from a fixed docs URL without sending local usage, paths, prompts, or statistics. If official parsing fails, it falls back to a public pricing table.
- With `--sync-git`, syncs token summaries through your private Git repository and updates that repo's README/PNG dashboard. It uploads hashed session ids, project basename hashes, token counts, model, time, and device name; project basenames are omitted unless `--sync-projects` is set.
- Has no runtime npm dependencies.
- Does not print prompts or assistant responses.
- Shows only project basenames by default; pass `--include-project-paths` if you want full paths.

Codex stores token counters in `event_msg` entries where `payload.type` is `token_count`. To avoid duplicate counts, the parser prefers deltas from `payload.info.total_token_usage` and only falls back to `payload.info.last_token_usage` if cumulative totals are absent.

## Usage

```bash
npm start
```

Short wrapped-style report:

```bash
npx . 2026 --brief
```

Useful variants:

```bash
npm start -- --year 2026
npm start -- --year 2026 --brief
npm start -- --today --brief --cost
npm start -- --this-week --brief --cost
npm start -- 2026 --brief --codex-home ~/.codex --codex-home ./imports/macbook --codex-home ./imports/work-wsl
npm start -- 2026 --group-by week --limit 60 --top-sessions 0
npm start -- 2026 --heatmap --top-sessions 0
npm start -- --group-by model --limit 10
npm start -- --group-by project --include-project-paths
npm start -- --cost --group-by model
npm start -- 2026 --brief --cost
npm start -- 2026 --brief --sync-git git@github.com:YOUR_NAME/codex-info-sync.git --device my-laptop
npm start -- --json
npm start -- --html report/codex-usage.html
```

You can also run the package as a local executable:

```bash
npx . --year 2026
```

## Merge Multiple Computers

The easiest ongoing workflow is Git sync. Keep this source repo for the tool code, and use a separate private repo for usage data. Run the same command on every machine with a different `--device` name:

```bash
npx . 2026 --brief --cost --sync-git git@github.com:YOUR_NAME/codex-info-sync.git --device laptop
npx . 2026 --brief --cost --sync-git git@github.com:YOUR_NAME/codex-info-sync.git --device desktop
npx . 2026 --brief --cost --sync-git git@github.com:YOUR_NAME/codex-info-sync.git --device workstation
```

Each run pulls the private repo, writes only that machine's device file, pushes it back, then reports the merged total across all devices. Running the same machine again updates existing session hashes instead of counting them twice.
Merged sync reports include a `Device sync` section showing each device's last successful sync time.
Each sync run also updates the private repo's `README.md` and `assets/codex-usage-heatmap.png`, so the private GitHub repo homepage becomes a visual dashboard for the latest command's date range. Add `--no-sync-readme` if you only want to update the device JSON data.
Sync always stores project hashes and optional project names from project basenames, even if your local terminal report uses `--include-project-paths`.

Add `--cost` to estimate cost from the merged usage. By default this uses OpenAI's `standard` token prices; pass `--pricing-tier batch`, `--pricing-tier flex`, or `--pricing-tier priority` if that better matches how you used the API.

The older manual import workflow also works:

On each other computer, export only Codex session files:

```bash
tar -czf codex-sessions-$(hostname).tgz -C "${CODEX_HOME:-$HOME/.codex}" sessions archived_sessions 2>/dev/null || tar -czf codex-sessions-$(hostname).tgz -C "${CODEX_HOME:-$HOME/.codex}" sessions
```

Copy the archives to this machine and extract each one under its own folder:

```bash
mkdir -p imports/macbook imports/old-wsl
tar -xzf codex-sessions-macbook.tgz -C imports/macbook
tar -xzf codex-sessions-old-wsl.tgz -C imports/old-wsl
```

Then run one merged report:

```bash
npx . 2026 --brief --codex-home ~/.codex --codex-home imports/macbook --codex-home imports/old-wsl
```

## Day, Week, and Calendar Views

The commands below pull the private sync repo first, so they report merged usage across all synced devices.

Current day across synced devices:

```bash
npx . --today --brief --cost --sync-git git@github.com:YOUR_NAME/codex-info-sync.git --device laptop
```

Current ISO week across synced devices, Monday through Sunday:

```bash
npx . --this-week --brief --cost --sync-git git@github.com:YOUR_NAME/codex-info-sync.git --device laptop
```

Every day in a year across synced devices:

```bash
npx . 2026 --group-by day --limit 366 --top-sessions 0 --sync-git git@github.com:YOUR_NAME/codex-info-sync.git --device laptop
```

Every week in a year across synced devices:

```bash
npx . 2026 --group-by week --limit 60 --top-sessions 0 --sync-git git@github.com:YOUR_NAME/codex-info-sync.git --device laptop
```

GitHub-style yearly token heatmap across synced devices:

```bash
npx . 2026 --heatmap --top-sessions 0 --sync-git git@github.com:YOUR_NAME/codex-info-sync.git --device laptop
```

PNG yearly token heatmap:

```bash
npx . 2026 --png report/codex-heatmap.png --top-sessions 0 --sync-git git@github.com:YOUR_NAME/codex-info-sync.git --device laptop
```

When `--sync-git` is present, the same PNG-style dashboard is also committed to the private sync repo README automatically. For a yearly dashboard in GitHub, run the yearly command above; for today's dashboard, run the `--today` command.

Replace `YOUR_NAME/codex-info-sync` with your own private sync repo, and replace `--device laptop` with the current machine's device name. To inspect only the current machine without cloud sync, omit the `--sync-git` and `--device` flags.

## Development

```bash
npm test
```
