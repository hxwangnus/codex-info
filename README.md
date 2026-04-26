# codex-info

Local-only Codex token usage reporter. It reads Codex session JSONL files from your machine, aggregates token usage, and prints a terminal report or writes a static HTML file.

## Privacy posture

- Reads `sessions/**/*.jsonl` under `CODEX_HOME` or `~/.codex`; pass `--codex-home` multiple times to merge machines.
- `archived_sessions/*.jsonl` is included only with `--include-archived`.
- Does not read `auth.json`, `config.toml`, `history.jsonl`, or `logs`.
- Makes no network requests by default.
- With `--cost` or `--online-metadata`, fetches public model/pricing metadata from fixed URLs without sending local usage, paths, prompts, or statistics.
- With `--sync-git`, syncs token summaries through your private Git repository. It uploads hashed session ids, token counts, model, time, and device name; project names are omitted unless `--sync-projects` is set.
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
npm start -- 2026 --brief --codex-home ~/.codex --codex-home ./imports/macbook --codex-home ./imports/work-wsl
npm start -- --group-by model --limit 10
npm start -- --group-by project --include-project-paths
npm start -- --cost --group-by model
npm start -- 2026 --brief --sync-git git@github.com:YOU/codex-info-sync.git --device xps13
npm start -- --json
npm start -- --html report/codex-usage.html
```

You can also run the package as a local executable:

```bash
npx . --year 2026
```

## Merge Multiple Computers

The easiest ongoing workflow is Git sync. Create one empty private repository, then run the same command on every machine with a different `--device` name:

```bash
npx . 2026 --brief --sync-git git@github.com:YOU/codex-info-sync.git --device xps13
npx . 2026 --brief --sync-git git@github.com:YOU/codex-info-sync.git --device macbook
npx . 2026 --brief --sync-git git@github.com:YOU/codex-info-sync.git --device blade18
```

Each run pulls the private repo, writes only that machine's device file, pushes it back, then reports the merged total across all devices. Running the same machine again updates existing session hashes instead of counting them twice.

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

## Development

```bash
npm test
```
