#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_CHECKPOINT_FILE_NAME,
  DEFAULT_COMMENT_JSON_FILE,
  DEFAULT_PROMPT_EXPORT_SUFFIX,
} from "./project-config.js";
import {
  applyDefaults,
  extractPrompt,
  getPassport,
  loadProjectEnv,
  runWorkflow,
  uploadImage,
} from "./prompt-api-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseCliArgs(argv) {
  const args = {
    inputFile: DEFAULT_COMMENT_JSON_FILE,
    outputDir: "",
    concurrency: 2,
    lang: "简体中文",
    skipReverse: false,
    renderOnly: false,
    resume: true,
    fresh: false,
    userCode: "",
    baseUrl: "",
    appCode: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      if (!args.inputFile || args.inputFile === DEFAULT_COMMENT_JSON_FILE) {
        args.inputFile = token;
      } else if (!args.outputDir) {
        args.outputDir = token;
      }
      continue;
    }

    const [flag, inlineValue] = token.split("=", 2);
    const readValue = () => inlineValue ?? argv[index + 1];

    switch (flag) {
      case "--input":
        args.inputFile = readValue();
        if (!inlineValue) index += 1;
        break;
      case "--output":
        args.outputDir = readValue();
        if (!inlineValue) index += 1;
        break;
      case "--concurrency":
        args.concurrency = Number(readValue()) || 2;
        if (!inlineValue) index += 1;
        break;
      case "--lang":
        args.lang = readValue();
        if (!inlineValue) index += 1;
        break;
      case "--skip-reverse":
        args.skipReverse = true;
        break;
      case "--render-only":
        args.renderOnly = true;
        break;
      case "--fresh":
        args.fresh = true;
        args.resume = false;
        break;
      case "--resume":
        args.resume = true;
        args.fresh = false;
        break;
      case "--user-code":
        args.userCode = readValue();
        if (!inlineValue) index += 1;
        break;
      case "--base-url":
        args.baseUrl = readValue();
        if (!inlineValue) index += 1;
        break;
      case "--app-code":
        args.appCode = readValue();
        if (!inlineValue) index += 1;
        break;
      default:
        break;
    }
  }

  return args;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeText(value, fallback = "无") {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : fallback;
}

function hasActualText(value) {
  const trimmed = String(value ?? "").trim();
  return Boolean(trimmed) && trimmed !== "无";
}

function compactText(text) {
  return String(text ?? "").replace(/\s+/g, "");
}

function buildRowKey(row) {
  return [
    row.threadIndex ?? "",
    row.kind ?? "",
    row.user ?? "",
    row.imageIndex ?? "",
    row.imageUrl ?? "",
  ].join("::");
}

function textLength(text) {
  return compactText(text).length;
}

function scorePromptText(text) {
  const raw = String(text ?? "").trim();
  const len = textLength(raw);
  if (!raw || len < 4) {
    return -10;
  }

  let score = 0;
  const hasPromptWord = /(口令|提示词|指令|prompt)/i.test(raw);
  const hasCreationWord = /(帮我生成|生成图片|生成|保持|去除|使用|根据|以上传|以我|以照片|去掉背景|保持原长相|保持本人|保持脸|原比例|图生图|文生图|换背景|换成背景|重绘|返图)/i.test(raw);
  if (len >= 40) score += 2;
  if (len >= 80) score += 1;
  if (/(帮我生成|生成图片|生成|口令|提示词|指令|prompt|AI 口令|AI口令|以上传|使用这张|去除原图|去掉背景|保持人物|保持本人|保持脸|保持原长相|原比例|图生图|文生图|换背景|换成背景|重绘|返图)/i.test(raw)) {
    score += 4;
  }
  if (/^\s*(保持|生成|去除|使用|根据|以上传|以我|以照片|AI 口令|口令|提示词|指令|帮我生成|生成图片)/.test(raw)) {
    score += 1;
  }
  if (hasPromptWord && !hasCreationWord && len < 30) {
    score -= 6;
  }
  if (/(求(?:个|一下|下)?(?:口令|指令|提示词|prompt)|想要(?:口令|指令|提示词|prompt)|有没有(?:口令|指令|提示词|prompt)|有无(?:口令|指令|提示词|prompt)|发(?:一下|下|我)?(?:口令|指令|提示词|prompt)|私(?:信|发|你)(?:一下|下)?(?:口令|指令|提示词|prompt)|蹲(?:口令|指令|提示词|prompt)|求图|求个图|求一下图|评论区|主页复制|哪个|哪一个|交作业|谢谢)/.test(raw) && len < 80) {
    score -= 5;
  }

  return score;
}

function isPromptLike(text) {
  const raw = String(text ?? "").trim();
  const len = textLength(raw);
  if (!raw) {
    return false;
  }
  const score = scorePromptText(raw);
  return score >= 4 || (score >= 3 && len >= 24) || (/^(口令|提示词|指令|AI 口令|AI口令)/.test(raw) && len >= 8);
}

function truncateAtWatermarkCue(text) {
  const raw = String(text ?? "");
  const cuePattern = /(豆包AI生成|豆包|小红书(?:AI生成)?|小红书水印|水印|logo)/i;
  const match = cuePattern.exec(raw);
  if (!match || typeof match.index !== "number" || match.index < 0) {
    return raw;
  }

  const suffix = raw.slice(match.index);
  const sentenceBoundary = suffix.search(/[。！？!?；;\n]/);
  if (sentenceBoundary >= 0) {
    return raw.slice(0, match.index + sentenceBoundary + 1);
  }

  const clauseBoundary = suffix.search(/[，,、]/);
  if (clauseBoundary >= 0) {
    return raw.slice(0, match.index + clauseBoundary + 1);
  }

  return raw.slice(0, match.index + match[0].length);
}

function sanitizeReversePrompt(text) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n");
  if (!raw.trim()) {
    return "";
  }

  let cleaned = truncateAtWatermarkCue(raw);
  const watermarkPatterns = [
    // 例如：无法识别的水印位于右下角、无文字，无标识，无水印
    /(?:^|[，,。；;！!？?\n\s])(?:无法识别的水印位于右下角|无法识别的水印|无文字|无标识|无水印)(?=$|[，,。；;！!？?\n\s])/gi,
  ];

  for (const pattern of watermarkPatterns) {
    cleaned = cleaned.replace(pattern, " ");
  }

  cleaned = truncateAtWatermarkCue(cleaned);

  cleaned = cleaned
    .replace(/\n{3,}/g, "\n\n")
    .replace(/([，,。；;！!？?、\s])\1+/g, "$1");

  const seenFragments = new Set();
  const paragraphSegments = cleaned
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const uniqueParts = [];

      for (const part of line.split(/[，,、；;]+/)) {
        const trimmed = part.trim();
        if (!trimmed) {
          continue;
        }

        const key = compactText(trimmed);
        if (!key || seenFragments.has(key)) {
          continue;
        }

        seenFragments.add(key);
        uniqueParts.push(trimmed);
      }

      if (uniqueParts.length === 0) {
        return "";
      }

      return uniqueParts.join("，");
    })
    .filter(Boolean);

  cleaned = paragraphSegments.join("\n");

  cleaned = cleaned
    .replace(/[ \t]+/g, " ")
    .replace(/ *([，,。；;！!？?])/g, "$1")
    .replace(/([，,。；;！!？?]){2,}/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[，,。；;！!？?\s]+$/g, "")
    .replace(/^[，,。；;！!？?\s]+/g, "")
    .trim();

  return cleaned;
}

function collectRepeatedFragments(text) {
  const fragments = String(text ?? "")
    .split(/\n+/)
    .flatMap((line) => line.split(/[，,、；;]+/))
    .map((part) => compactText(part.trim()))
    .filter(Boolean);

  const counts = new Map();
  for (const fragment of fragments) {
    counts.set(fragment, (counts.get(fragment) || 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([fragment]) => fragment);
}

function extractImageSrc(image) {
  if (!image) {
    return "";
  }

  if (typeof image === "string") {
    return image.trim();
  }

  if (typeof image === "object") {
    const candidates = [image.url, image.src, image.link, image.image, image.originUrl];
    const matched = candidates.find((item) => typeof item === "string" && item.trim());
    return matched ? matched.trim() : "";
  }

  return "";
}

function normalizeImages(images) {
  if (!Array.isArray(images)) {
    return [];
  }

  return images.map(extractImageSrc).filter(Boolean);
}

function makeSafeName(value) {
  return String(value ?? "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "unknown";
}

function extFromContentType(contentType = "") {
  const value = String(contentType).toLowerCase();
  if (value.includes("image/webp")) return ".webp";
  if (value.includes("image/png")) return ".png";
  if (value.includes("image/gif")) return ".gif";
  if (value.includes("image/jpeg")) return ".jpg";
  return ".jpg";
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

function normalizeSavedRow(saved, fallbackRow) {
  if (!saved || typeof saved !== "object") {
    return null;
  }

  const savedOriginalPrompt = normalizeText(saved.originalPrompt, "");
  const fallbackOriginalPrompt = normalizeText(fallbackRow.originalPrompt, "");

  return {
    ...fallbackRow,
    ...saved,
    rowKey: fallbackRow.rowKey,
    status: saved.status || "done",
    originalPrompt: savedOriginalPrompt || fallbackOriginalPrompt,
    reversePrompt: sanitizeReversePrompt(saved.reversePrompt || ""),
    reverseError: saved.reverseError || "",
    localImageAbs: saved.localImageAbs || "",
    localImageRel: saved.localImageRel || "",
  };
}

function checkpointMatches(state, meta) {
  if (!state || typeof state !== "object") {
    return false;
  }

  const source = state.meta || {};
  return source.inputAbsPath === meta.inputAbsPath
    && source.inputSize === meta.inputSize
    && source.inputMtimeMs === meta.inputMtimeMs
    && source.outputDir === meta.outputDir
    && source.baseUrl === meta.baseUrl
    && source.appCode === meta.appCode
    && source.userCode === meta.userCode
    && source.lang === meta.lang;
}

function buildThreadEntries(item) {
  const entries = [];
  const comment = item?.comment || {};
  entries.push({
    kind: "主评论",
    user: comment.user || "匿名用户",
    text: comment.text || "",
    images: normalizeImages(comment.images),
    time: comment.time || "",
    location: comment.location || "",
    replyTo: "",
    sourceIndex: item?.index ?? 0,
  });

  for (const reply of item?.replies || []) {
    entries.push({
      kind: "子评论",
      user: reply?.user || "匿名用户",
      text: reply?.text || "",
      images: normalizeImages(reply?.images),
      time: reply?.time || "",
      location: reply?.location || "",
      replyTo: reply?.replyTo || "",
      sourceIndex: item?.index ?? 0,
    });
  }

  return entries;
}

function scoreOriginalPromptCandidate(entry, rootUser) {
  const raw = String(entry?.text ?? "").trim();
  if (!isPromptLike(raw)) {
    return -Infinity;
  }

  let score = scorePromptText(raw);
  if (entry?.user && rootUser && entry.user === rootUser) {
    score += 4;
  }
  if (/^(口令|提示词|指令|prompt|AI 口令|AI口令)/i.test(raw)) {
    score += 2;
  }
  if (textLength(raw) >= 120) {
    score += 1;
  }

  return score;
}

function collectOriginalPrompt(entry, threadEntries) {
  const candidates = threadEntries
    .map((item, index) => ({
      item,
      index,
      score: scoreOriginalPromptCandidate(item, entry.user),
    }))
    .filter(({ score }) => Number.isFinite(score) && score > -Infinity)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const uniqueTexts = [];
  for (const candidate of candidates) {
    const text = normalizeText(candidate.item.text);
    if (!text || text === "无") {
      continue;
    }
    if (!uniqueTexts.includes(text)) {
      uniqueTexts.push(text);
    }
    if (uniqueTexts.length >= 3) {
      break;
    }
  }

  if (uniqueTexts.length > 0) {
    return uniqueTexts.join("\n\n");
  }

  if (isPromptLike(entry.text)) {
    return normalizeText(entry.text);
  }

  return "无";
}

function flattenRows(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const rows = [];

  for (const item of items) {
    const threadEntries = buildThreadEntries(item);
    for (const entry of threadEntries) {
      if (!entry.images.length) {
        continue;
      }
      for (let imageIndex = 0; imageIndex < entry.images.length; imageIndex += 1) {
        const imageUrl = entry.images[imageIndex];
        const row = {
          threadIndex: item?.index ?? rows.length + 1,
          user: entry.user,
          kind: entry.kind,
          text: entry.text,
          imageUrl,
          imageIndex: imageIndex + 1,
          imageTotal: entry.images.length,
          originalPrompt: collectOriginalPrompt(entry, threadEntries),
          sourceTime: entry.time,
          sourceLocation: entry.location,
          replyTo: entry.replyTo,
        };

        rows.push({
          ...row,
          rowKey: buildRowKey(row),
        });
      }
    }
  }

  return rows;
}

async function downloadImage(url, targetPath) {
  const response = await fetch(url, {
    headers: {
      referer: "https://www.xiaohongshu.com/",
      "user-agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) {
    throw new Error(`下载图片失败 ${response.status}: ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(targetPath, buffer);
  return {
    bytes: buffer.length,
    contentType: response.headers.get("content-type") || "",
  };
}

async function mapWithConcurrency(items, limit, iterator) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await iterator(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.max(1, limit) }, () => worker());
  await Promise.all(workers);
  return results;
}

function buildHtml(rows, meta) {
  const repeatedFragmentCount = rows.reduce((total, row) => {
    const fragments = collectRepeatedFragments(row.reversePrompt);
    return total + fragments.length;
  }, 0);
  const tableRows = rows.map((row, index) => {
    const promptHtml = escapeHtml(row.originalPrompt || "无").replace(/\n/g, "<br>");
    const sanitizedReversePrompt = sanitizeReversePrompt(row.reversePrompt || "");
    const reverseText = row.reverseError
      || (hasActualText(sanitizedReversePrompt) ? sanitizedReversePrompt : "待补抓");
    const reverseHtml = escapeHtml(reverseText).replace(/\n/g, "<br>");
    const imageHtml = row.localImageRel
      ? `
          <a href="${escapeHtml(row.localImageRel)}" target="_blank" rel="noreferrer">
            <img src="${escapeHtml(row.localImageRel)}" alt="图片 ${index + 1}">
          </a>
        `
      : `<div class="missing-image">${escapeHtml(row.status === "error" ? "未完成" : "处理中")}</div>`;
    return `
      <tr>
        <td class="col-index">${index + 1}</td>
        <td class="col-user">
          <div class="user">${escapeHtml(row.user)}</div>
          <div class="meta">${escapeHtml(row.kind)} · 线程 ${escapeHtml(row.threadIndex)}${row.imageTotal > 1 ? ` · 第 ${row.imageIndex}/${row.imageTotal} 张` : ""}</div>
        </td>
        <td class="col-image">${imageHtml}</td>
        <td class="col-prompt"><div class="text-block">${promptHtml}</div></td>
        <td class="col-reverse"><div class="text-block">${reverseHtml}</div></td>
      </tr>
    `;
  }).join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>小红书评论图片提示词提取</title>
  <style>
    :root {
      --bg: #f4efe7;
      --panel: rgba(255, 255, 255, 0.9);
      --line: #dfd4c6;
      --text: #2b2520;
      --muted: #74675e;
      --accent: #8a5a44;
      --accent-soft: #f4e5dc;
      --shadow: 0 16px 40px rgba(84, 63, 45, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(138, 90, 68, 0.12), transparent 28%),
        radial-gradient(circle at top right, rgba(255, 255, 255, 0.7), transparent 24%),
        linear-gradient(180deg, #f8f3eb 0%, #efe4d7 100%);
    }
    .page {
      width: min(1680px, calc(100vw - 24px));
      margin: 0 auto;
      padding: 16px 0 28px;
    }
    .hero {
      padding: 16px 18px;
      border: 1px solid rgba(255,255,255,0.7);
      border-radius: 18px;
      background: var(--panel);
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
    }
    .eyebrow {
      display: inline-flex;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
    }
    h1 { margin: 8px 0 0; font-size: clamp(22px, 2.8vw, 34px); }
    .desc { margin: 8px 0 0; color: var(--muted); line-height: 1.6; }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 14px;
    }
    .stat {
      padding: 12px 14px;
      border-radius: 14px;
      background: rgba(255,255,255,0.72);
      border: 1px solid var(--line);
    }
    .stat .label { color: var(--muted); font-size: 12px; }
    .stat .value { margin-top: 6px; font-size: 22px; font-weight: 800; }
    .table-wrap {
      margin-top: 14px;
      border-radius: 18px;
      overflow: auto;
      background: rgba(255,255,255,0.88);
      box-shadow: var(--shadow);
      border: 1px solid rgba(255,255,255,0.8);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 1300px;
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: #f6efe6;
      color: var(--accent);
      text-align: left;
      padding: 14px 12px;
      border-bottom: 1px solid var(--line);
      font-size: 13px;
    }
    tbody td {
      vertical-align: top;
      padding: 12px;
      border-bottom: 1px solid #eee2d6;
      font-size: 14px;
      line-height: 1.6;
    }
    tbody tr:nth-child(2n) { background: rgba(250, 246, 240, 0.7); }
    .col-index { width: 72px; font-weight: 800; }
    .col-user { width: 220px; }
    .col-image { width: 220px; }
    .col-prompt { width: 420px; }
    .col-reverse { width: auto; }
    .user { font-weight: 700; }
    .meta { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .text-block {
      white-space: pre-wrap;
      word-break: break-word;
    }
    .col-image img {
      display: block;
      width: 180px;
      max-width: 100%;
      border-radius: 12px;
      border: 1px solid var(--line);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.08);
      background: #fff;
    }
    .missing-image {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 120px;
      width: 180px;
      border-radius: 12px;
      border: 1px dashed var(--line);
      color: var(--muted);
      background: rgba(255, 255, 255, 0.55);
      font-size: 13px;
    }
    @media (max-width: 980px) {
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <span class="eyebrow">离线提示词提取</span>
      <h1>小红书评论图片提示词提取结果</h1>
      <div class="desc">
        来源文件：${escapeHtml(meta.inputFile)}<br>
        输出目录：${escapeHtml(meta.outputDir)}<br>
        说明：图片已下载到本地，HTML 打开后可直接离线查看；反推提示词使用 get-prompt-api，语言固定为简体中文，并已启用水印清理与重复片段过滤。
      </div>
      <div class="stats">
        <div class="stat"><div class="label">图片条数</div><div class="value">${meta.totalRows}</div></div>
        <div class="stat"><div class="label">带原作者提示词</div><div class="value">${meta.promptRows}</div></div>
        <div class="stat"><div class="label">反推成功</div><div class="value">${meta.reverseOkRows}</div></div>
        <div class="stat"><div class="label">失败/待补抓</div><div class="value">${meta.reverseFailRows}</div></div>
      </div>
      <div class="desc" style="margin-top:10px;">
        当前页共检测到 ${repeatedFragmentCount} 个重复片段，已在展示时自动过滤。
      </div>
    </section>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>序列</th>
            <th>用户</th>
            <th>图片</th>
            <th>原作者提示词</th>
            <th>反推提示词</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows || `<tr><td colspan="5">未找到可导出的图片记录</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

async function main() {
  loadProjectEnv();

  const cli = parseCliArgs(process.argv.slice(2));
  const baseConfig = applyDefaults({
    baseUrl: cli.baseUrl,
    appCode: cli.appCode,
    userCode: cli.userCode,
    lang: cli.lang,
  });

  const inputFile = path.resolve(cli.inputFile);
  const inputBase = path.basename(inputFile, path.extname(inputFile));
  const outputDir = path.resolve(cli.outputDir || `${inputBase}${DEFAULT_PROMPT_EXPORT_SUFFIX}`);
  const imagesDir = path.join(outputDir, "images");
  const htmlPath = path.join(outputDir, "index.html");
  const jsonPath = path.join(outputDir, "rows.json");
  const checkpointPath = path.join(outputDir, DEFAULT_CHECKPOINT_FILE_NAME);

  const inputRaw = await fs.readFile(inputFile, "utf8");
  const data = JSON.parse(inputRaw);
  const rows = flattenRows(data);
  const inputStat = await fs.stat(inputFile);
  const checkpointMeta = {
    inputAbsPath: inputFile,
    inputSize: inputStat.size,
    inputMtimeMs: inputStat.mtimeMs,
    outputDir,
    baseUrl: baseConfig.baseUrl,
    appCode: baseConfig.appCode,
    userCode: baseConfig.userCode,
    lang: cli.lang || "简体中文",
    skipReverse: cli.skipReverse,
  };

  await ensureDir(imagesDir);

  if (cli.renderOnly) {
    const existingReport = await readJsonIfExists(jsonPath);
    const existingRowsMap = new Map();
    if (Array.isArray(existingReport?.rows)) {
      for (const savedRow of existingReport.rows) {
        if (savedRow?.rowKey) {
          existingRowsMap.set(savedRow.rowKey, savedRow);
        }
      }
    }

    const mergedRows = rows.map((row) => {
      const savedRow = existingRowsMap.get(row.rowKey);
      return normalizeSavedRow(savedRow, row) || row;
    });

    const summary = {
      inputFile: path.basename(inputFile),
      outputDir,
      totalRows: mergedRows.length,
      promptRows: mergedRows.filter((row) => normalizeText(row.originalPrompt, "无") !== "无").length,
      reverseOkRows: mergedRows.filter((row) => row.status === "done" && hasActualText(row.reversePrompt) && !row.reverseError).length,
      reverseFailRows: mergedRows.filter((row) => row.status !== "done" || row.reverseError || !hasActualText(row.reversePrompt)).length,
    };

    await fs.writeFile(jsonPath, JSON.stringify({ summary, rows: mergedRows }, null, 2), "utf8");
    await fs.writeFile(htmlPath, buildHtml(mergedRows, summary), "utf8");

    console.log(JSON.stringify({
      ok: true,
      outputDir,
      htmlPath,
      jsonPath,
      summary,
      renderOnly: true,
    }, null, 2));
    return;
  }

  const passport = cli.skipReverse ? "" : await getPassport(baseConfig);
  const rawCheckpoint = cli.resume ? await readJsonIfExists(checkpointPath) : null;
  const shouldResume = cli.resume && checkpointMatches(rawCheckpoint, checkpointMeta);
  const checkpointMap = new Map();
  if (shouldResume && Array.isArray(rawCheckpoint?.rows)) {
    for (const savedRow of rawCheckpoint.rows) {
      if (savedRow?.rowKey) {
        checkpointMap.set(savedRow.rowKey, savedRow);
      }
    }
  }

  if (cli.resume && rawCheckpoint && !shouldResume) {
    console.log("检测到已有断点文件，但与当前输入或配置不匹配，已自动忽略并重新开始。");
  } else if (shouldResume && checkpointMap.size > 0) {
    console.log(`检测到断点记录：${checkpointMap.size}/${rows.length} 条，可继续处理剩余部分。`);
  }

  const initialRows = rows.map((row) => {
    const saved = checkpointMap.get(row.rowKey);
    return normalizeSavedRow(saved, row);
  });
  let pendingCheckpointWrite = Promise.resolve();

  async function persistCheckpoint() {
    const payload = {
      version: 1,
      meta: checkpointMeta,
      updatedAt: new Date().toISOString(),
      rows: initialRows.filter(Boolean),
    };
    await writeJsonAtomic(checkpointPath, payload);
  }

  function queueCheckpointSave() {
    pendingCheckpointWrite = pendingCheckpointWrite
      .then(() => persistCheckpoint())
      .catch((error) => {
        console.error(`写入断点文件失败：${error instanceof Error ? error.message : String(error)}`);
      });
    return pendingCheckpointWrite;
  }

  function getProgressCount() {
    return initialRows.filter((row) => row && (row.status === "done" || row.status === "error")).length;
  }

  const downloadCache = new Map();
  const preparedRows = await mapWithConcurrency(rows, Math.max(1, cli.concurrency), async (row, index) => {
    const savedRow = initialRows[index];
    if (
      savedRow?.status === "done"
      && savedRow.localImageAbs
      && (await fileExists(savedRow.localImageAbs))
      && (cli.skipReverse || hasActualText(savedRow.reversePrompt))
    ) {
      return savedRow;
    }

    const result = normalizeSavedRow(savedRow, row) || {
      ...row,
      status: "pending",
      reversePrompt: "",
      reverseError: "",
      localImageAbs: "",
      localImageRel: "",
    };

    try {
      let localImageAbs = result.localImageAbs;
      if (!localImageAbs || !(await fileExists(localImageAbs))) {
        const imageKey = row.imageUrl;
        let cachedImage = downloadCache.get(imageKey);

        if (!cachedImage) {
          const downloadPromise = (async () => {
            const baseName = `${String(index + 1).padStart(4, "0")}_${makeSafeName(row.user)}_${row.kind}_${row.imageIndex}`;
            const tempTarget = path.join(imagesDir, `${baseName}.bin`);
            const { contentType } = await downloadImage(row.imageUrl, tempTarget);
            const finalTarget = path.join(imagesDir, `${baseName}${extFromContentType(contentType)}`);
            await fs.rename(tempTarget, finalTarget);
            return finalTarget;
          })();
          downloadCache.set(imageKey, downloadPromise);
          cachedImage = downloadPromise;
        }

        localImageAbs = typeof cachedImage?.then === "function" ? await cachedImage : cachedImage;
        downloadCache.set(row.imageUrl, localImageAbs);
      }

      result.localImageAbs = localImageAbs;
      result.localImageRel = path.relative(outputDir, localImageAbs).split(path.sep).join("/");
      result.reversePrompt = result.reversePrompt || "";
      result.reverseError = "";

      if (!cli.skipReverse) {
        const shouldRetryReverse = result.status !== "done" || !hasActualText(result.reversePrompt);
        if (shouldRetryReverse) {
          const uploaded = await uploadImage({ ...baseConfig, passport, imagePath: localImageAbs });
          const runResult = await runWorkflow({
            ...baseConfig,
            passport,
            lang: cli.lang || "简体中文",
            uploadFileId: uploaded.id,
          });
          const cleanedPrompt = sanitizeReversePrompt(extractPrompt(runResult.output));
          result.reversePrompt = cleanedPrompt || "无";
        } else {
          result.reversePrompt = sanitizeReversePrompt(result.reversePrompt) || "无";
        }
      }

      result.status = "done";
    } catch (error) {
      result.status = "error";
      result.reverseError = error instanceof Error ? error.message : String(error);
    }

    initialRows[index] = result;
    await queueCheckpointSave();

    const progressCount = getProgressCount();
    if (progressCount === 1 || progressCount % 10 === 0 || progressCount === rows.length) {
      console.log(`已完成 ${progressCount}/${rows.length} 条图片记录`);
    }

    return result;
  });

  const summary = {
    inputFile: path.basename(inputFile),
    outputDir,
    totalRows: preparedRows.length,
    promptRows: preparedRows.filter((row) => normalizeText(row.originalPrompt, "无") !== "无").length,
    reverseOkRows: preparedRows.filter((row) => row.status === "done" && hasActualText(row.reversePrompt) && !row.reverseError).length,
    reverseFailRows: preparedRows.filter((row) => row.status !== "done" || row.reverseError || !hasActualText(row.reversePrompt)).length,
  };

  await fs.writeFile(jsonPath, JSON.stringify({ summary, rows: preparedRows }, null, 2), "utf8");
  await fs.writeFile(htmlPath, buildHtml(preparedRows, summary), "utf8");

  console.log(JSON.stringify({
    ok: true,
    outputDir,
    htmlPath,
    jsonPath,
    summary,
  }, null, 2));
}

if (process.argv[1] === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export {
  sanitizeReversePrompt,
};
