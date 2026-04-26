import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectUsage, normalizeUsage, diffUsage } from "../src/usage.js";
import { syncGitUsage, updateSyncReadme } from "../src/sync-git.js";
import { parseOpenAiPricingMarkdown } from "../src/metadata.js";
import { renderBriefReport, renderHtmlReport } from "../src/format.js";
import { renderHeatmapPng, writeHeatmapPng } from "../src/heatmap-png.js";

test("normalizes usage field aliases", () => {
  assert.deepEqual(normalizeUsage({
    input_tokens: 10,
    cache_read_input_tokens: 4,
    output_tokens: 3,
    reasoning_output_tokens: 2,
    total_tokens: 13
  }), {
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 3,
    reasoningOutputTokens: 2,
    totalTokens: 13
  });
});

test("diffs cumulative total usage", () => {
  const previous = normalizeUsage({ input_tokens: 10, output_tokens: 2, total_tokens: 12 });
  const total = normalizeUsage({ input_tokens: 15, output_tokens: 5, total_tokens: 20 });
  assert.deepEqual(diffUsage(total, previous), {
    inputTokens: 5,
    cachedInputTokens: 0,
    outputTokens: 3,
    reasoningOutputTokens: 0,
    totalTokens: 8
  });
});

test("collects only session files and avoids duplicate token_count rows", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-info-"));
  const sessionDir = path.join(root, "sessions", "2026", "04", "26");
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.writeFile(path.join(root, "auth.json"), "{\"secret\":\"ignored\"}\n");
  await fs.promises.writeFile(path.join(root, "history.jsonl"), "{\"ts\":\"2026-04-26T00:00:00Z\",\"text\":\"ignored\"}\n");
  await fs.promises.writeFile(path.join(sessionDir, "rollout-2026-04-26T01-02-03-test.jsonl"), [
    JSON.stringify({ timestamp: "2026-04-26T01:02:03.000Z", type: "session_meta", payload: { id: "test", timestamp: "2026-04-26T01:02:03.000Z", cwd: "/tmp/project-alpha", source: "cli" } }),
    JSON.stringify({ timestamp: "2026-04-26T01:02:04.000Z", type: "turn_context", payload: { model: "gpt-test", effort: "medium", cwd: "/tmp/project-alpha" } }),
    JSON.stringify({ timestamp: "2026-04-26T01:02:05.000Z", type: "event_msg", payload: { type: "user_message", message: "ignored prompt" } }),
    JSON.stringify({ timestamp: "2026-04-26T01:02:06.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 40, reasoning_output_tokens: 5, total_tokens: 140 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 40, reasoning_output_tokens: 5, total_tokens: 140 } } } }),
    JSON.stringify({ timestamp: "2026-04-26T01:02:07.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 40, reasoning_output_tokens: 5, total_tokens: 140 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 40, reasoning_output_tokens: 5, total_tokens: 140 } } } })
  ].join("\n"));

  const result = await collectUsage({ codexHome: root });
  assert.equal(result.summary.sessions, 1);
  assert.equal(result.summary.userMessages, 1);
  assert.equal(result.summary.usage.totalTokens, 140);
  assert.equal(result.summary.usage.cachedInputTokens, 25);
  assert.equal(result.groups.model[0].model, "gpt-test");
  assert.equal(result.groups.project[0].project, "project-alpha");
  assert.equal(result.groups.week[0].week, "2026-W17");
});

test("merges multiple Codex homes and skips duplicate session ids", async () => {
  const rootA = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-info-a-"));
  const rootB = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-info-b-"));
  await writeSession(rootA, "same-id", "2026-04-26T01:00:00.000Z", "/tmp/a", "gpt-a", 10);
  await writeSession(rootB, "same-id", "2026-04-26T01:00:00.000Z", "/tmp/a", "gpt-a", 10);
  await writeSession(rootB, "other-id", "2026-04-26T02:00:00.000Z", "/tmp/b", "gpt-b", 20);

  const result = await collectUsage({ codexHomes: [rootA, rootB], year: "2026" });
  assert.equal(result.summary.sessions, 2);
  assert.equal(result.summary.duplicateSessions, 1);
  assert.equal(result.summary.usage.totalTokens, 30);
  assert.equal(result.groups.model.length, 2);
});

test("syncs through a private Git-style remote without double counting reruns", async () => {
  if (!hasGit()) return;

  const remote = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-info-remote-"));
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });

  const rootA = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-info-sync-a-"));
  const rootB = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-info-sync-b-"));
  const cacheA = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-info-cache-a-"));
  const cacheB = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-info-cache-b-"));

  await writeSession(rootA, "sync-a", "2026-04-26T01:00:00.000Z", "/tmp/a", "gpt-a", 10);
  await writeSession(rootB, "sync-b", "2026-04-26T02:00:00.000Z", "/tmp/b", "gpt-b", 20);

  const localA = await collectUsage({ codexHomes: [rootA], year: "2026" });
  const mergedA = await syncGitUsage(localA, { syncGit: remote, syncCache: path.join(cacheA, "repo"), syncDevice: "xps13", year: "2026" });
  assert.equal(mergedA.summary.sessions, 1);
  assert.equal(mergedA.summary.usage.totalTokens, 10);

  const localB = await collectUsage({ codexHomes: [rootB], year: "2026" });
  const mergedB = await syncGitUsage(localB, { syncGit: remote, syncCache: path.join(cacheB, "repo"), syncDevice: "macbook", year: "2026" });
  assert.equal(mergedB.summary.sessions, 2);
  assert.equal(mergedB.summary.devices, 2);
  assert.equal(mergedB.summary.usage.totalTokens, 30);
  assert.deepEqual(mergedB.summary.sync.devicesLastSynced.map((item) => item.device), ["macbook", "xps13"]);
  assert.ok(mergedB.summary.sync.devicesLastSynced.every((item) => item.updatedAt));

  const readmeSync = await updateSyncReadme(mergedB, { syncGit: remote, syncCache: path.join(cacheB, "repo"), syncDevice: "macbook", year: "2026" });
  assert.equal(readmeSync.pushed, true);
  const readme = await fs.promises.readFile(path.join(cacheB, "repo", "README.md"), "utf8");
  assert.match(readme, /Codex Usage Report/);
  assert.match(readme, /assets\/codex-usage-heatmap\.png/);
  assert.match(readme, /xps13/);
  const png = await fs.promises.readFile(path.join(cacheB, "repo", "assets", "codex-usage-heatmap.png"));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const rerunA = await syncGitUsage(localA, { syncGit: remote, syncCache: path.join(cacheA, "repo"), syncDevice: "xps13", year: "2026" });
  assert.equal(rerunA.summary.sessions, 2);
  assert.equal(rerunA.summary.usage.totalTokens, 30);
});

test("sync uploads only project basenames even when local output uses full paths", async () => {
  if (!hasGit()) return;

  const remote = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-info-remote-"));
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });

  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-info-full-path-"));
  const cache = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-info-cache-"));
  await writeSession(root, "path-sync", "2026-04-26T01:00:00.000Z", "/private/home/user/secret-project", "gpt-a", 10);

  const local = await collectUsage({ codexHomes: [root], year: "2026", includeProjectPaths: true });
  assert.equal(local.sessions[0].project, "/private/home/user/secret-project");

  await syncGitUsage(local, {
    syncGit: remote,
    syncCache: path.join(cache, "repo"),
    syncDevice: "laptop",
    syncProjects: true,
    year: "2026"
  });

  const deviceFile = await fs.promises.readFile(path.join(cache, "repo", "codex-info", "devices", "laptop.json"), "utf8");
  assert.match(deviceFile, /secret-project/);
  assert.doesNotMatch(deviceFile, /\/private\/home\/user/);
});

test("parses OpenAI official pricing markdown rows", () => {
  const markdown = `
<div data-content-switcher-pane data-value="standard">
  <TextTokenPricingTables
    tier="standard"
    rows={[
      ["gpt-test (<272K context length)", 2.5, 0.25, 15],
      ["gpt-test-mini", 0.5, 0.05, 2],
    ]}
  />
</div>`;
  const pricing = parseOpenAiPricingMarkdown(markdown, "standard");
  assert.equal(pricing.get("gpt-test").inputCostPerMillionTokens, 2.5);
  assert.equal(pricing.get("gpt-test").cachedInputCostPerMillionTokens, 0.25);
  assert.equal(pricing.get("gpt-test").outputCostPerMillionTokens, 15);
});

test("brief report prints estimated cost without numeric formatting loss", () => {
  const text = renderBriefReport({
    summary: {
      sessions: 1,
      userMessages: 1,
      activeDays: 1,
      projects: 1,
      models: 1,
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 15 },
      estimatedCostUSD: 0.1234,
      pricedModels: 1,
      pricingSource: "openai",
      pricingTier: "standard",
      dateRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T00:00:00.000Z" }
    },
    groups: {
      model: [{ model: "gpt-test", usage: { totalTokens: 15 }, estimatedCostUSD: 0.1234 }]
    }
  }, { year: "2026", topModels: 1 });
  assert.match(text, /estimated:\s+\$0\.1234/);
  assert.match(text, /gpt-test\s+15 tokens\s+\$0\.1234/);
});

test("brief report prints per-device sync times", () => {
  const text = renderBriefReport({
    summary: {
      sessions: 1,
      userMessages: 1,
      activeDays: 1,
      projects: 1,
      models: 1,
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 15 },
      sync: {
        devicesLastSynced: [
          { device: "macbook16", updatedAt: "2026-04-26T01:02:03.000Z", sessions: 7 },
          { device: "xps13", updatedAt: "2026-04-26T02:03:04.000Z", sessions: 9 }
        ]
      },
      dateRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T00:00:00.000Z" }
    },
    groups: {
      model: [{ model: "gpt-test", usage: { totalTokens: 15 } }]
    }
  }, { year: "2026", topModels: 1 });
  assert.match(text, /Device sync:/);
  assert.match(text, /macbook16: 2026-04-26 01:02:03 UTC/);
  assert.match(text, /xps13: 2026-04-26 02:03:04 UTC/);
});

test("filters a local date range and keeps weekly groups", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-info-range-"));
  await writeSession(root, "range-a", "2026-04-26T01:00:00.000Z", "/tmp/a", "gpt-a", 10);
  await writeSession(root, "range-b", "2026-04-27T01:00:00.000Z", "/tmp/b", "gpt-b", 20);

  const result = await collectUsage({ codexHomes: [root], since: "2026-04-26", until: "2026-04-26" });
  assert.equal(result.summary.sessions, 1);
  assert.equal(result.summary.usage.totalTokens, 10);
  assert.equal(result.groups.day[0].date, "2026-04-26");
  assert.equal(result.groups.week[0].week, "2026-W17");
});

test("renders a PNG heatmap", async () => {
  const result = {
    summary: {
      usage: { totalTokens: 1234567 },
      dateRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-12-31T00:00:00.000Z" }
    },
    groups: {
      day: [
        { date: "2026-04-26", usage: { totalTokens: 100 } },
        { date: "2026-04-27", usage: { totalTokens: 400 } }
      ]
    }
  };
  const buffer = renderHeatmapPng(result, { year: "2026" });
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR");

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-info-png-"));
  const file = await writeHeatmapPng(result, path.join(dir, "heatmap.png"), { year: "2026" });
  const stat = await fs.promises.stat(file);
  assert.ok(stat.size > 1000);
});

test("HTML dashboard can embed a local heatmap image", () => {
  const html = renderHtmlReport({
    summary: {
      sessions: 1,
      userMessages: 1,
      activeDays: 1,
      projects: 1,
      models: 1,
      tokenEvents: 1,
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0, totalTokens: 15 },
      dateRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T00:00:00.000Z" }
    },
    groups: {
      day: [{ date: "2026-01-01", sessions: 1, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, totalTokens: 15 } }]
    },
    sessions: []
  }, {
    year: "2026",
    topSessions: 0,
    heatmapImage: "codex-heatmap-2026.png"
  });

  assert.match(html, /Usage Heatmap/);
  assert.match(html, /codex-heatmap-2026\.png/);
});

async function writeSession(root, id, timestamp, cwd, model, totalTokens) {
  const sessionDir = path.join(root, "sessions", "2026", "04", "26");
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.writeFile(path.join(sessionDir, `rollout-2026-04-26T01-02-03-${id}.jsonl`), [
    JSON.stringify({ timestamp, type: "session_meta", payload: { id, timestamp, cwd, source: "cli" } }),
    JSON.stringify({ timestamp, type: "turn_context", payload: { model, cwd } }),
    JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: totalTokens, output_tokens: 0, total_tokens: totalTokens } } } })
  ].join("\n"));
}

function hasGit() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
