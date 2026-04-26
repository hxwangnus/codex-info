import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { addDays, localDateKey, startOfLocalIsoWeek, startOfLocalToday } from "./date-utils.js";

const COLORS = {
  background: [246, 248, 250, 255],
  panel: [255, 255, 255, 255],
  text: [31, 35, 40, 255],
  muted: [87, 96, 106, 255],
  border: [208, 215, 222, 255],
  cells: [
    [235, 237, 240, 255],
    [172, 238, 187, 255],
    [74, 194, 107, 255],
    [45, 164, 78, 255],
    [17, 99, 41, 255]
  ]
};

const FONT = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "$": ["00100", "01111", "10100", "01110", "00101", "11110", "00100"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"]
};

export async function writeHeatmapPng(result, outputPath, options = {}) {
  const buffer = renderHeatmapPng(result, options);
  const fullPath = path.resolve(outputPath);
  await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.promises.writeFile(fullPath, buffer);
  return fullPath;
}

export function renderHeatmapPng(result, options = {}) {
  const year = Number(options.year || result.summary.dateRange?.start?.slice(0, 4) || new Date().getFullYear());
  const heatmap = heatmapData(result, year);
  const cell = 12;
  const gap = 3;
  const left = 94;
  const top = 222;
  const width = 960;
  const height = 540;
  const started = startedSummary(result, options.now ? new Date(options.now) : new Date());
  const image = createImage(width, height, COLORS.background);

  drawText(image, 32, 24, `CODEX USAGE ${year}`, COLORS.text, 3);
  drawText(image, 32, 56, "LOCAL AND SYNCED MESSAGE ACTIVITY", COLORS.muted, 1);

  drawMetricCard(image, 32, 82, 142, "TOKENS", formatCompact(result.summary.usage.totalTokens));
  drawMetricCard(image, 188, 82, 142, "MESSAGES", formatCompact(result.summary.userMessages));
  drawMetricCard(image, 344, 82, 132, "SESSIONS", formatCompact(result.summary.sessions));
  drawMetricCard(image, 490, 82, 132, "ACTIVE DAYS", formatCompact(result.summary.activeDays));
  drawMetricCard(image, 636, 82, 156, "STARTED", started.date, started.elapsed);
  drawMetricCard(image, 806, 82, 122, "COST", costLabel(result));

  drawPanel(image, 32, 158, 896, 222);
  drawText(image, 54, 172, "DAILY MESSAGE HEATMAP", COLORS.text, 2);
  drawText(image, 724, 174, "MESSAGES / DAY", COLORS.muted, 1);
  drawText(image, 724, 188, `MAX ${formatCompact(heatmap.max)}`, COLORS.muted, 1);
  drawMonthLabels(image, heatmap.gridStart, heatmap.weeks, left, 204, cell, gap);
  drawWeekdayLabels(image, left - 40, top + 2, cell, gap);

  for (let col = 0; col < heatmap.weeks; col += 1) {
    for (let row = 0; row < 7; row += 1) {
      const date = addDays(heatmap.gridStart, col * 7 + row);
      const inYear = date >= heatmap.start && date <= heatmap.end;
      const value = inYear ? heatmap.dayMessages.get(localDateKey(date)) || 0 : 0;
      const color = inYear ? colorForValue(value, heatmap.thresholds) : COLORS.background;
      const x = left + col * (cell + gap);
      const y = top + row * (cell + gap);
      fillRect(image, x, y, cell, cell, color);
      strokeRect(image, x, y, cell, cell, COLORS.border);
    }
  }

  const legendY = top + 7 * (cell + gap) + 24;
  drawText(image, left, legendY + 1, "FEWER", COLORS.muted, 1);
  for (let index = 0; index < COLORS.cells.length; index += 1) {
    fillRect(image, left + 50 + index * (cell + gap), legendY, cell, cell, COLORS.cells[index]);
    strokeRect(image, left + 50 + index * (cell + gap), legendY, cell, cell, COLORS.border);
  }
  drawText(image, left + 50 + COLORS.cells.length * (cell + gap) + 6, legendY + 1, "MORE", COLORS.muted, 1);

  drawPanel(image, 32, 404, 424, 104);
  drawText(image, 52, 418, "TOP MODELS", COLORS.text, 2);
  drawModelRows(image, result, 52, 446);

  drawPanel(image, 488, 404, 440, 104);
  drawText(image, 508, 418, "USAGE DETAIL", COLORS.text, 2);
  drawUsageRows(image, result, 508, 446);

  return encodePng(image);
}

function heatmapData(result, year) {
  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  const gridStart = startOfLocalIsoWeek(start);
  const gridEnd = addDays(startOfLocalIsoWeek(addDays(end, 6)), 6);
  const weeks = Math.ceil((gridEnd - gridStart) / 86400000 / 7) + 1;
  const dayMessages = new Map((result.groups.day || []).map((row) => [row.date, row.userMessages || 0]));
  const values = [...dayMessages.values()];
  const max = Math.max(0, ...values);
  return { start, end, gridStart, weeks, dayMessages, max, thresholds: colorThresholds(values) };
}

function createImage(width, height, color) {
  const pixels = Buffer.alloc(width * height * 4);
  const image = { width, height, pixels };
  fillRect(image, 0, 0, width, height, color);
  return image;
}

function fillRect(image, x, y, width, height, color) {
  for (let yy = y; yy < y + height; yy += 1) {
    for (let xx = x; xx < x + width; xx += 1) {
      setPixel(image, xx, yy, color);
    }
  }
}

function drawPanel(image, x, y, width, height) {
  fillRect(image, x, y, width, height, COLORS.panel);
  strokeRect(image, x, y, width, height, COLORS.border);
}

function drawMetricCard(image, x, y, width, label, value, detail = "") {
  drawPanel(image, x, y, width, 58);
  drawText(image, x + 12, y + 10, label, COLORS.muted, 1);
  drawText(image, x + 12, y + 25, value, COLORS.text, 2);
  if (detail) drawText(image, x + 12, y + 45, detail, COLORS.muted, 1);
}

function strokeRect(image, x, y, width, height, color) {
  for (let xx = x; xx < x + width; xx += 1) {
    setPixel(image, xx, y, color);
    setPixel(image, xx, y + height - 1, color);
  }
  for (let yy = y; yy < y + height; yy += 1) {
    setPixel(image, x, yy, color);
    setPixel(image, x + width - 1, yy, color);
  }
}

function setPixel(image, x, y, color) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const offset = (y * image.width + x) * 4;
  image.pixels[offset] = color[0];
  image.pixels[offset + 1] = color[1];
  image.pixels[offset + 2] = color[2];
  image.pixels[offset + 3] = color[3];
}

function drawText(image, x, y, text, color, scale = 1) {
  let cursor = x;
  for (const char of String(text).toUpperCase()) {
    const glyph = FONT[char] || FONT[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] === "1") {
          fillRect(image, cursor + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursor += 6 * scale;
  }
}

function drawModelRows(image, result, x, y) {
  const rows = (result.groups.model || []).slice(0, 3);
  if (!rows.length) {
    drawText(image, x, y, "NO MODEL DATA", COLORS.muted, 1);
    return;
  }
  for (const [index, row] of rows.entries()) {
    const label = `${shorten(row.model, 18)} ${formatCompact(row.usage.totalTokens)}`;
    const cost = typeof row.estimatedCostUSD === "number" ? ` ${formatCost(row.estimatedCostUSD)}` : "";
    drawText(image, x, y + index * 13, `${label}${cost}`, COLORS.muted, 1);
  }
}

function drawUsageRows(image, result, x, y) {
  const usage = result.summary.usage || {};
  drawUsageMetric(image, x, y, "INPUT", usage.inputTokens);
  drawUsageMetric(image, x + 214, y, "OUTPUT", usage.outputTokens);
  drawUsageMetric(image, x, y + 28, "CACHED", usage.cachedInputTokens);
  drawUsageMetric(image, x + 214, y + 28, "REASONING", usage.reasoningOutputTokens);
}

function drawUsageMetric(image, x, y, label, value) {
  drawText(image, x, y, label, COLORS.muted, 1);
  drawText(image, x, y + 12, formatCompact(value), COLORS.text, 1);
}

function drawMonthLabels(image, gridStart, weeks, left, y, cell, gap) {
  const names = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const year = addDays(gridStart, 10).getFullYear();
  for (let month = 0; month < 12; month += 1) {
    const first = new Date(year, month, 1);
    const col = Math.max(0, Math.floor((startOfLocalIsoWeek(first) - gridStart) / 86400000 / 7));
    if (col < weeks) drawText(image, left + col * (cell + gap), y, names[month], COLORS.muted, 1);
  }
}

function drawWeekdayLabels(image, x, y, cell, gap) {
  for (const [index, label] of ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].entries()) {
    drawText(image, x, y + index * (cell + gap) + 1, label, COLORS.muted, 1);
  }
}

function colorForValue(value, thresholds) {
  if (!value) return COLORS.cells[0];
  if (value <= thresholds[0]) return COLORS.cells[1];
  if (value <= thresholds[1]) return COLORS.cells[2];
  if (value <= thresholds[2]) return COLORS.cells[3];
  return COLORS.cells[4];
}

function colorThresholds(values) {
  const nonzero = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (!nonzero.length) return [1, 2, 3];
  return [
    quantile(nonzero, 0.25),
    quantile(nonzero, 0.5),
    quantile(nonzero, 0.75)
  ];
}

function quantile(sortedValues, ratio) {
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((sortedValues.length - 1) * ratio)));
  return sortedValues[index];
}

function encodePng(image) {
  const raw = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const rowStart = y * (image.width * 4 + 1);
    raw[rowStart] = 0;
    image.pixels.copy(raw, rowStart + 1, y * image.width * 4, (y + 1) * image.width * 4);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr(image.width, image.height)),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function ihdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function formatCompact(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000_000) return `${trimDecimal(number / 1_000_000_000)}B`;
  if (number >= 1_000_000) return `${trimDecimal(number / 1_000_000)}M`;
  if (number >= 1_000) return `${trimDecimal(number / 1_000)}K`;
  return String(Math.round(number));
}

function trimDecimal(value) {
  return value.toFixed(value >= 10 ? 1 : 2).replace(/\.?0+$/, "");
}

function costLabel(result) {
  return typeof result.summary.estimatedCostUSD === "number" ? formatCost(result.summary.estimatedCostUSD) : "N/A";
}

function formatCost(value) {
  return `$${trimDecimal(Number(value) || 0)}`;
}

function startedSummary(result, now) {
  const date = parseDate(result.summary.dateRange?.start);
  if (!date) return { date: "N/A", elapsed: "" };
  const started = startOfLocalToday(date);
  const today = startOfLocalToday(now);
  const days = Math.max(0, Math.floor((today - started) / 86400000));
  return {
    date: formatDate(started),
    elapsed: `${formatWholeDays(days)} AGO`
  };
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatWholeDays(value) {
  const days = Math.max(0, Math.floor(Number(value) || 0));
  return days === 1 ? "1 DAY" : `${formatCompact(days)} DAYS`;
}

function shorten(value, max) {
  const text = String(value || "").toUpperCase();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}.`;
}
