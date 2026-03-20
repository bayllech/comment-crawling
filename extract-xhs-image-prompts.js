#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import { createInterface } from "readline/promises";
import { fileURLToPath } from "url";
import ExcelJS from "exceljs";
import sharp from "sharp";
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
    inputFile: "",
    inputProvided: false,
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
        args.inputProvided = true;
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
        args.inputProvided = true;
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
    reversePrompt: typeof saved.reversePrompt === "string" ? saved.reversePrompt : String(saved.reversePrompt ?? ""),
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

function isIgnoredDirectoryName(dirName) {
  return (
    dirName === "node_modules"
    || dirName === ".git"
    || dirName === ".cocoindex_code"
    || dirName === ".idea"
    || dirName === "dist"
    || dirName === "build"
    || dirName.endsWith("-prompt-export")
  );
}

function isIgnoredJsonFile(fileName) {
  return (
    fileName === "package.json"
    || fileName === "package-lock.json"
    || fileName === "rows.json"
    || fileName.endsWith(".resume.json")
  );
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "未知大小";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知时间";
  }

  return date.toLocaleString("zh-CN");
}

function formatProgressBar(done, total, width = 24) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeDone = Math.max(0, Math.min(Number(done) || 0, safeTotal));

  if (safeTotal === 0) {
    return "[------------------------] 0/0";
  }

  const ratio = safeDone / safeTotal;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const empty = Math.max(0, width - filled);
  const percent = Math.round(ratio * 100);
  return `[${"#".repeat(filled)}${"-".repeat(empty)}] ${safeDone}/${safeTotal} (${percent}%)`;
}

function createProgressRenderer() {
  const isInteractive = process.stdout.isTTY;
  let lastSnapshot = "";

  function render(lines) {
    const snapshot = lines.join("\n");
    if (snapshot === lastSnapshot) {
      return;
    }

    lastSnapshot = snapshot;

    if (isInteractive) {
      process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(`${snapshot}\n`);
      return;
    }

    console.log(snapshot);
  }

  return {
    render,
    isInteractive,
  };
}

async function collectJsonFiles(rootDir) {
  const result = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "EACCES" || error?.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isIgnoredDirectoryName(entry.name)) {
          continue;
        }
        await walk(path.join(currentDir, entry.name));
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
        continue;
      }
      if (isIgnoredJsonFile(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        result.push({
          path: fullPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // 文件在扫描过程中被移动或删除时，直接跳过。
      }
    }
  }

  await walk(rootDir);
  result.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
  return result;
}

async function chooseInputFile({ inputFile, inputProvided }) {
  if (inputProvided) {
    const resolved = path.resolve(inputFile || "");
    if (!resolved || !(await fileExists(resolved))) {
      throw new Error(`指定的输入文件不存在：${inputFile || "空路径"}`);
    }
    return resolved;
  }

  const candidates = await collectJsonFiles(process.cwd());
  if (candidates.length === 0) {
    if (await fileExists(path.resolve(DEFAULT_COMMENT_JSON_FILE))) {
      return path.resolve(DEFAULT_COMMENT_JSON_FILE);
    }
    throw new Error("当前目录及子目录未找到可用的 JSON 文件，请手动传入 --input <文件路径>");
  }

  if (candidates.length === 1) {
    return candidates[0].path;
  }

  if (!process.stdin.isTTY) {
    return candidates[0].path;
  }

  console.log("检测到多个 JSON 文件，请选择一个：");
  candidates.slice(0, 40).forEach((item, index) => {
    const relativePath = path.relative(process.cwd(), item.path);
    console.log(`  ${String(index + 1).padStart(2, "0")}. ${relativePath}  (${formatFileSize(item.size)}，${formatTime(item.mtimeMs)})`);
  });

  if (candidates.length > 40) {
    console.log(`  ... 另外还有 ${candidates.length - 40} 个文件未显示`);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = (await rl.question("输入编号或直接粘贴文件路径，回车默认第 1 个：")).trim();
    if (!answer) {
      return candidates[0].path;
    }

    const numeric = Number(answer);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= candidates.length) {
      return candidates[numeric - 1].path;
    }

    const manualPath = path.resolve(answer);
    if (await fileExists(manualPath)) {
      return manualPath;
    }

    console.log("未找到你输入的文件，已自动改为第 1 个候选。");
    return candidates[0].path;
  } finally {
    rl.close();
  }
}

function createPromptInterface() {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function askQuestion(rl, question) {
  return (await rl.question(question)).trim();
}

function buildHtml(rows, meta) {
  const tableRows = rows.map((row, index) => {
    const promptHtml = escapeHtml(row.originalPrompt || "无").replace(/\n/g, "<br>");
    const reverseText = row.reverseError
      || (hasActualText(row.reversePrompt) ? row.reversePrompt : "待补抓");
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
      <div class="stats">
        <div class="stat"><div class="label">图片条数</div><div class="value">${meta.totalRows}</div></div>
        <div class="stat"><div class="label">带评论区提示词</div><div class="value">${meta.promptRows}</div></div>
        <div class="stat"><div class="label">反推成功</div><div class="value">${meta.reverseOkRows}</div></div>
        <div class="stat"><div class="label">失败/待补抓</div><div class="value">${meta.reverseFailRows}</div></div>
      </div>
    </section>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>序列</th>
            <th>用户</th>
            <th>图片</th>
            <th>评论区提示词</th>
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

function normalizeExcelImageExtension(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".png") return "png";
  if (ext === ".gif") return "gif";
  if (ext === ".jpg" || ext === ".jpeg") return "jpeg";
  return "";
}

async function readExcelImagePayload(imagePath) {
  const extension = normalizeExcelImageExtension(imagePath);
  if (extension) {
    return {
      extension,
      buffer: await fs.readFile(imagePath),
    };
  }

  const converted = await sharp(imagePath).png().toBuffer();
  return {
    extension: "png",
    buffer: converted,
  };
}

const EXCEL_IMAGE_BOX = {
  width: 132,
  height: 132,
  paddingX: 8,
  paddingY: 6,
  cellWidth: 160,
  cellHeight: 144,
};

function buildExcelUserCell(row) {
  const parts = [
    normalizeText(row.user, "匿名用户"),
    `${normalizeText(row.kind, "未知类型")} · 线程 ${row.threadIndex ?? "-"}`,
  ];

  if (Number(row.imageTotal) > 1) {
    parts[1] += ` · 第 ${row.imageIndex}/${row.imageTotal} 张`;
  }

  return parts.join("\n");
}

function buildExcelPromptCell(text, fallback) {
  return `\n${normalizeText(text, fallback)}\n`;
}

async function buildExcelImagePlacement(imagePath, rowNumber) {
  const metadata = await sharp(imagePath).metadata();
  const sourceWidth = Number(metadata.width) || EXCEL_IMAGE_BOX.width;
  const sourceHeight = Number(metadata.height) || EXCEL_IMAGE_BOX.height;
  const scale = Math.min(
    EXCEL_IMAGE_BOX.width / sourceWidth,
    EXCEL_IMAGE_BOX.height / sourceHeight,
    1,
  );
  const renderWidth = Math.max(1, Math.round(sourceWidth * scale));
  const renderHeight = Math.max(1, Math.round(sourceHeight * scale));
  const offsetX = EXCEL_IMAGE_BOX.paddingX + Math.max(0, (EXCEL_IMAGE_BOX.width - renderWidth) / 2);
  const offsetY = EXCEL_IMAGE_BOX.paddingY + Math.max(0, (EXCEL_IMAGE_BOX.height - renderHeight) / 2);
  const cellTopLeft = { col: 2, row: rowNumber - 1 };

  return {
    tl: {
      col: cellTopLeft.col + (offsetX / EXCEL_IMAGE_BOX.cellWidth),
      row: cellTopLeft.row + (offsetY / EXCEL_IMAGE_BOX.cellHeight),
    },
    ext: {
      width: renderWidth,
      height: renderHeight,
    },
    editAs: "oneCell",
  };
}

async function fillExcelWorksheet({
  workbook,
  worksheet,
  rows,
  layout,
}) {
  worksheet.columns = [
    { header: "序列", key: "index", width: layout.indexWidth },
    { header: "用户", key: "user", width: layout.userWidth },
    { header: "图片", key: "image", width: layout.imageWidth },
    { header: "评论区提示词", key: "originalPrompt", width: layout.promptWidth },
    { header: "反推提示词", key: "reversePrompt", width: layout.reverseWidth },
  ];

  const headerRow = worksheet.getRow(1);
  headerRow.height = layout.headerHeight;
  headerRow.font = { bold: true, color: { argb: "FF8A5A44" } };
  headerRow.alignment = { vertical: "middle", horizontal: "left" };
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF6EFE6" },
    };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD8CBBB" } },
      left: { style: "thin", color: { argb: "FFD8CBBB" } },
      bottom: { style: "thin", color: { argb: "FFD8CBBB" } },
      right: { style: "thin", color: { argb: "FFD8CBBB" } },
    };
  });

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    const reverseText = row.reverseError
      || (hasActualText(row.reversePrompt) ? row.reversePrompt : "待补抓");

    worksheet.getCell(`A${rowNumber}`).value = index + 1;
    worksheet.getCell(`B${rowNumber}`).value = buildExcelUserCell(row);
    worksheet.getCell(`C${rowNumber}`).value = "";
    worksheet.getCell(`D${rowNumber}`).value = buildExcelPromptCell(row.originalPrompt, "无");
    worksheet.getCell(`E${rowNumber}`).value = buildExcelPromptCell(reverseText, "待补抓");

    worksheet.getRow(rowNumber).height = layout.rowHeight;

    ["A", "B", "C", "D", "E"].forEach((column) => {
      const cell = worksheet.getCell(`${column}${rowNumber}`);
      cell.alignment = {
        vertical: column === "C" ? "middle" : "top",
        horizontal: column === "A" || column === "C" ? "center" : "left",
        wrapText: column !== "C",
      };
      cell.border = {
        top: { style: "thin", color: { argb: "FFE7DCCD" } },
        left: { style: "thin", color: { argb: "FFE7DCCD" } },
        bottom: { style: "thin", color: { argb: "FFE7DCCD" } },
        right: { style: "thin", color: { argb: "FFE7DCCD" } },
      };
    });

    if (row.localImageAbs && await fileExists(row.localImageAbs)) {
      const imagePayload = await readExcelImagePayload(row.localImageAbs);
      const imageId = workbook.addImage(imagePayload);
      const placement = await buildExcelImagePlacement(row.localImageAbs, rowNumber);
      worksheet.addImage(imageId, placement);
    } else {
      worksheet.getCell(`C${rowNumber}`).value = row.status === "error" ? "未完成" : "处理中";
      worksheet.getCell(`C${rowNumber}`).alignment = {
        vertical: "middle",
        horizontal: "center",
        wrapText: true,
      };
    }
  }
}

async function exportExcelReport(rows, meta, outputPath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "comment-crawling";
  workbook.created = new Date();
  workbook.modified = new Date();

  const worksheet = workbook.addWorksheet("图片提示词", {
    views: [{ state: "frozen", xSplit: 3, ySplit: 1 }],
    properties: { defaultRowHeight: 24 },
  });
  await fillExcelWorksheet({
    workbook,
    worksheet,
    rows,
    layout: {
      indexWidth: 8,
      userWidth: 26,
      imageWidth: 22,
      promptWidth: 72,
      reverseWidth: 72,
      headerHeight: 24,
      rowHeight: 124,
    },
  });

  worksheet.eachRow((row) => {
    row.eachCell((cell) => {
      if (cell.col === 1) {
        cell.alignment = { ...cell.alignment, horizontal: "center" };
      }
    });
  });

  await workbook.xlsx.writeFile(outputPath);
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

  const inputFile = await chooseInputFile(cli);
  const inputBase = path.basename(inputFile, path.extname(inputFile));
  const outputDir = path.resolve(cli.outputDir || `${inputBase}${DEFAULT_PROMPT_EXPORT_SUFFIX}`);
  const imagesDir = path.join(outputDir, "images");
  const htmlPath = path.join(outputDir, "index.html");
  const excelPath = path.join(outputDir, "index.xlsx");
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
    await exportExcelReport(mergedRows, summary, excelPath);

    console.log(JSON.stringify({
      ok: true,
      outputDir,
      htmlPath,
      excelPath,
      jsonPath,
      summary,
      renderOnly: true,
    }, null, 2));
    return;
  }

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

  const records = rows.map((row) => {
    const saved = checkpointMap.get(row.rowKey);
    return normalizeSavedRow(saved, row) || {
      ...row,
      status: "pending",
      originalPrompt: normalizeText(row.originalPrompt, "无"),
      reversePrompt: "",
      reverseError: "",
      localImageAbs: "",
      localImageRel: "",
    };
  });
  let pendingCheckpointWrite = Promise.resolve();
  const progress = createProgressRenderer();
  const downloadCache = new Map();

  async function persistCheckpoint() {
    const payload = {
      version: 1,
      meta: checkpointMeta,
      updatedAt: new Date().toISOString(),
      rows: records.filter(Boolean),
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

  function isReverseSatisfied(record) {
    return record.status === "done" && hasActualText(record.reversePrompt) && !record.reverseError;
  }

  function renderDashboard({
    stageText = "准备开始",
    downloadDone = 0,
    downloadTotal = 0,
    reverseDone = 0,
    reverseTotal = 0,
    reverseSkipped = false,
  }) {
    const promptRows = records.filter((record) => normalizeText(record.originalPrompt, "无") !== "无").length;
    progress.render([
      "小红书评论图片一键转换",
      `源文件：${path.relative(process.cwd(), inputFile)}`,
      `输出目录：${path.relative(process.cwd(), outputDir)}`,
      `评论区提示词：已提取 ${promptRows}/${records.length} 条`,
      `下载图片：${formatProgressBar(downloadDone, downloadTotal)}`,
      reverseSkipped
        ? "评论区提示词反推：已跳过"
        : `反推提示词：${formatProgressBar(reverseDone, reverseTotal)}`,
      `当前状态：${stageText}`,
    ]);
  }

  renderDashboard({ stageText: "正在分析待处理任务" });

  const downloadPlan = await Promise.all(records.map(async (record, index) => ({
    index,
    needsDownload: !(record.localImageAbs && await fileExists(record.localImageAbs)),
  })));
  const downloadTargets = downloadPlan.filter((item) => item.needsDownload).map((item) => item.index);
  const concurrency = Math.max(1, cli.concurrency);

  let downloadDone = 0;
  renderDashboard({
    stageText: downloadTargets.length > 0 ? "开始下载图片" : "没有需要下载的图片",
    downloadDone: 0,
    downloadTotal: downloadTargets.length,
    reverseDone: 0,
    reverseTotal: 0,
    reverseSkipped: cli.skipReverse,
  });

  if (downloadTargets.length > 0) {
    await mapWithConcurrency(downloadTargets, concurrency, async (rowIndex) => {
      const record = records[rowIndex];

      try {
        let localImageAbs = record.localImageAbs;
        if (!localImageAbs || !(await fileExists(localImageAbs))) {
          const imageKey = record.imageUrl;
          let cachedImage = downloadCache.get(imageKey);

          if (!cachedImage) {
            const downloadPromise = (async () => {
              const baseName = `${String(rowIndex + 1).padStart(4, "0")}_${makeSafeName(record.user)}_${record.kind}_${record.imageIndex}`;
              const tempTarget = path.join(imagesDir, `${baseName}.bin`);
              const { contentType } = await downloadImage(record.imageUrl, tempTarget);
              const finalTarget = path.join(imagesDir, `${baseName}${extFromContentType(contentType)}`);
              await fs.rename(tempTarget, finalTarget);
              return finalTarget;
            })();
            downloadCache.set(imageKey, downloadPromise);
            cachedImage = downloadPromise;
          }

          localImageAbs = typeof cachedImage?.then === "function" ? await cachedImage : cachedImage;
          downloadCache.set(record.imageUrl, localImageAbs);
        }

        record.localImageAbs = localImageAbs;
        record.localImageRel = path.relative(outputDir, localImageAbs).split(path.sep).join("/");
        record.reverseError = "";

        if (cli.skipReverse || isReverseSatisfied(record)) {
          record.status = "done";
        } else {
          record.status = "downloaded";
        }
      } catch (error) {
        record.status = "error";
        record.reverseError = error instanceof Error ? error.message : String(error);
      }

      downloadDone += 1;
      await queueCheckpointSave();
      renderDashboard({
        stageText: `下载中 ${downloadDone}/${downloadTargets.length}`,
        downloadDone,
        downloadTotal: downloadTargets.length,
        reverseDone: 0,
        reverseTotal: 0,
        reverseSkipped: cli.skipReverse,
      });

      return record;
    });
  }

  const reversePlan = cli.skipReverse
    ? []
    : await Promise.all(records.map(async (record, index) => {
      const hasLocalImage = record.localImageAbs && await fileExists(record.localImageAbs);
      return {
        index,
        needsReverse: hasLocalImage && !isReverseSatisfied(record) && record.status !== "error",
      };
    }));
  const reverseTargets = reversePlan.filter((item) => item.needsReverse).map((item) => item.index);
  let reverseDone = 0;
  let passport = "";

  if (!cli.skipReverse && reverseTargets.length > 0) {
    passport = await getPassport(baseConfig);
  }

  renderDashboard({
    stageText: cli.skipReverse
      ? "已跳过评论区提示词反推"
      : reverseTargets.length > 0
        ? "开始评论区提示词反推"
        : "没有需要反推的图片",
    downloadDone,
    downloadTotal: downloadTargets.length,
    reverseDone: 0,
    reverseTotal: reverseTargets.length,
    reverseSkipped: cli.skipReverse,
  });

  if (!cli.skipReverse && reverseTargets.length > 0) {
    await mapWithConcurrency(reverseTargets, concurrency, async (rowIndex) => {
      const record = records[rowIndex];

      try {
        if (!record.localImageAbs || !(await fileExists(record.localImageAbs))) {
          throw new Error("本地图片不存在，无法进行评论区提示词反推");
        }

        const uploaded = await uploadImage({ ...baseConfig, passport, imagePath: record.localImageAbs });
        const runResult = await runWorkflow({
          ...baseConfig,
          passport,
          lang: cli.lang || "简体中文",
          uploadFileId: uploaded.id,
        });
        const rawPrompt = extractPrompt(runResult.output);
        record.reversePrompt = typeof rawPrompt === "string" ? rawPrompt : String(rawPrompt ?? "");
        record.reverseError = "";
        record.status = "done";
      } catch (error) {
        record.status = "error";
        record.reverseError = error instanceof Error ? error.message : String(error);
      }

      reverseDone += 1;
      await queueCheckpointSave();
      renderDashboard({
        stageText: `反推中 ${reverseDone}/${reverseTargets.length}`,
        downloadDone,
        downloadTotal: downloadTargets.length,
        reverseDone,
        reverseTotal: reverseTargets.length,
        reverseSkipped: false,
      });

      return record;
    });
  }

  const summary = {
    inputFile: path.basename(inputFile),
    outputDir,
    totalRows: records.length,
    downloadRows: downloadTargets.length,
    reverseRows: reverseTargets.length,
    promptRows: records.filter((record) => normalizeText(record.originalPrompt, "无") !== "无").length,
    reverseOkRows: records.filter((record) => record.status === "done" && hasActualText(record.reversePrompt) && !record.reverseError).length,
    reverseFailRows: records.filter((record) => record.status !== "done" || record.reverseError || !hasActualText(record.reversePrompt)).length,
  };

  await queueCheckpointSave();
  const html = buildHtml(records, summary);
  await fs.writeFile(jsonPath, JSON.stringify({ summary, rows: records }, null, 2), "utf8");
  await fs.writeFile(htmlPath, html, "utf8");
  await exportExcelReport(records, summary, excelPath);

  renderDashboard({
    stageText: "全部完成，正在生成最终页面",
    downloadDone: downloadTargets.length,
    downloadTotal: downloadTargets.length,
    reverseDone: reverseTargets.length,
    reverseTotal: reverseTargets.length,
    reverseSkipped: cli.skipReverse,
  });

  console.log("");
  console.log("全部完成。");
  console.log(`输出目录：${outputDir}`);
  console.log(`HTML 入口：${path.relative(process.cwd(), htmlPath)}`);
  console.log(`Excel 入口：${path.relative(process.cwd(), excelPath)}`);
  console.log("直接打开 index.html 即可查看。");
}

if (process.argv[1] === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
