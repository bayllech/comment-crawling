#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { DEFAULT_COMMENT_JSON_FILE } from "./project-config.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatText(text) {
  const safeText = escapeHtml(text || "无正文");
  return safeText.replace(/\r?\n/g, "<br>");
}

function needsCollapse(text) {
  const raw = String(text || "无正文").trim();
  const plainLength = raw.replace(/\s+/g, "").length;
  const lineCount = raw.split(/\r?\n/).length;
  return plainLength > 90 || lineCount > 3;
}

function normalizeText(value, fallback = " - ") {
  if (value === null || value === undefined) {
    return fallback;
  }

  const trimmed = String(value).trim();
  return trimmed ? escapeHtml(trimmed) : fallback;
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

function renderImages(images) {
  const list = normalizeImages(images);
  if (list.length === 0) {
    return '<span class="muted">无</span>';
  }

  const thumbs = list
    .map((src, index) => {
      const safeSrc = escapeHtml(src);
      return `
        <a class="thumb-link" href="${safeSrc}" target="_blank" rel="noreferrer" title="查看原图 ${index + 1}">
          <img class="thumb-image" src="${safeSrc}" alt="图片 ${index + 1}" loading="lazy">
        </a>
      `;
    })
    .join("");

  return `<div class="thumb-list">${thumbs}</div>`;
}

function flattenRows(items) {
  return items.flatMap((item, itemIndex) => {
    const comment = item && typeof item === "object" ? item.comment || {} : {};
    const replies = Array.isArray(item?.replies) ? item.replies : [];
    const groupIndex = item?.index ?? itemIndex + 1;
    const replyCount = replies.length;

    const mainRow = {
      groupIndex,
      rowType: "主评论",
      user: comment.user,
      replyTo: "",
      time: comment.time,
      location: comment.location,
      text: comment.text,
      images: comment.images,
      replyCount,
    };

    const replyRows = replies.map((reply) => ({
      groupIndex,
      rowType: "回复",
      user: reply?.user,
      replyTo: reply?.replyTo,
      time: reply?.time,
      location: reply?.location,
      text: reply?.text,
      images: reply?.images,
      replyCount: "",
    }));

    return [mainRow, ...replyRows];
  });
}

function buildRowsHtml(items) {
  const rows = flattenRows(items);

  if (rows.length === 0) {
    return `
      <tr>
        <td colspan="7" class="empty-cell">未找到评论数据</td>
      </tr>
    `;
  }

  return rows
    .map((row) => {
      const rowClass = row.rowType === "主评论" ? "row-main" : "row-reply";
      const badgeClass = row.rowType === "主评论" ? "badge-main" : "badge-reply";
      const collapsible = needsCollapse(row.text);
      const textHtml = formatText(row.text);
      const textCellHtml = collapsible
        ? `
            <div class="text-block">
              <div class="text-content is-collapsed">${textHtml}</div>
              <button type="button" class="text-toggle" onclick="toggleText(this)">展开</button>
            </div>
          `
        : `<div class="text-block"><div class="text-content is-expanded">${textHtml}</div></div>`;

      return `
        <tr class="${rowClass}">
          <td class="col-index">${escapeHtml(row.groupIndex)}</td>
          <td class="col-type"><span class="badge ${badgeClass}">${row.rowType}</span></td>
          <td class="col-user">
            <div class="user-name">${normalizeText(row.user, "匿名用户")}</div>
            ${row.replyTo ? `<div class="reply-to">回复 ${escapeHtml(row.replyTo)}</div>` : ""}
          </td>
          <td class="col-meta">${normalizeText(row.time)}<br>${normalizeText(row.location)}</td>
          <td class="col-text">${textCellHtml}</td>
          <td class="col-images">${renderImages(row.images)}</td>
          <td class="col-replies">${row.rowType === "主评论" ? escapeHtml(row.replyCount) : '<span class="muted"> - </span>'}</td>
        </tr>
      `;
    })
    .join("");
}

function buildHtml(data, sourceFile) {
  const items = Array.isArray(data.items) ? data.items : [];
  const totalReplies = items.reduce((sum, item) => sum + (Array.isArray(item?.replies) ? item.replies.length : 0), 0);
  const totalImages = items.reduce((sum, item) => {
    const commentImages = normalizeImages(item?.comment?.images).length;
    const replyImages = Array.isArray(item?.replies)
      ? item.replies.reduce((replySum, reply) => replySum + normalizeImages(reply?.images).length, 0)
      : 0;
    return sum + commentImages + replyImages;
  }, 0);
  const totalRows = items.length + totalReplies;
  const sourceName = path.basename(sourceFile);
  const title = `${path.basename(sourceFile, path.extname(sourceFile))} 评论展示`;
  const safeUrl = data.url ? escapeHtml(data.url) : "";
  const rowsHtml = buildRowsHtml(items);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #eef3f7;
      --panel: #ffffff;
      --panel-soft: #f8fbfd;
      --line: #d8e1e8;
      --line-strong: #c8d4de;
      --text: #1f2933;
      --muted: #66788a;
      --accent: #d84f3f;
      --accent-soft: #fff1ee;
      --reply: #1f7a8c;
      --reply-soft: #eaf7fa;
      --shadow: 0 18px 45px rgba(31, 41, 51, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: var(--text);
      font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(216, 79, 63, 0.10), transparent 28%),
        radial-gradient(circle at top right, rgba(31, 122, 140, 0.10), transparent 24%),
        linear-gradient(180deg, #f7fafc 0%, #edf2f7 100%);
    }

    a {
      color: inherit;
    }

    .page {
      width: min(1560px, calc(100vw - 24px));
      margin: 0 auto;
      padding: 16px 0 28px;
    }

    .hero {
      padding: 16px 18px;
      border: 1px solid rgba(255, 255, 255, 0.75);
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.88);
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
    }

    .hero-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .eyebrow {
      display: inline-flex;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
    }

    h1 {
      margin: 8px 0 0;
      font-size: clamp(22px, 2.8vw, 34px);
      line-height: 1.1;
    }

    .hero-desc {
      margin: 8px 0 0;
      color: var(--muted);
      line-height: 1.6;
      font-size: 14px;
    }

    .source-box {
      min-width: min(420px, 100%);
      max-width: 100%;
      padding: 10px 12px;
      border-radius: 14px;
      background: var(--panel-soft);
      border: 1px solid var(--line);
    }

    .source-label {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }

    .source-link {
      word-break: break-all;
      text-decoration: none;
      color: #0f5f73;
      font-size: 13px;
      line-height: 1.5;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 10px;
      margin-top: 14px;
    }

    .stat {
      padding: 12px;
      border-radius: 14px;
      background: var(--panel-soft);
      border: 1px solid var(--line);
    }

    .stat-label {
      font-size: 12px;
      color: var(--muted);
    }

    .stat-value {
      margin-top: 6px;
      font-size: 24px;
      font-weight: 700;
      line-height: 1;
    }

    .table-panel {
      margin-top: 14px;
      border-radius: 18px;
      overflow-x: auto;
      overflow-y: visible;
      border: 1px solid rgba(216, 225, 232, 0.95);
      background: rgba(255, 255, 255, 0.92);
      box-shadow: var(--shadow);
    }

    .table-scroll {
      overflow: visible;
    }

    table {
      width: 100%;
      min-width: 1220px;
      border-collapse: separate;
      border-spacing: 0;
    }

    thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      padding: 12px 10px;
      background: #f3f7fa;
      color: #385061;
      text-align: left;
      font-size: 12px;
      letter-spacing: 0.03em;
      border-bottom: 1px solid var(--line-strong);
      white-space: nowrap;
    }

    tbody td {
      padding: 10px;
      vertical-align: top;
      border-bottom: 1px solid #e8eef3;
      font-size: 13px;
      line-height: 1.55;
    }

    tbody tr:hover td {
      background: #fbfdff;
    }

    .row-main td {
      background: rgba(255, 245, 241, 0.55);
    }

    .row-reply td {
      background: rgba(250, 253, 255, 0.92);
    }

    .col-index {
      width: 72px;
      font-weight: 700;
      text-align: center;
      white-space: nowrap;
    }

    .col-type {
      width: 88px;
    }

    .col-user {
      width: 180px;
    }

    .col-meta {
      width: 132px;
      color: var(--muted);
      white-space: nowrap;
    }

    .col-text {
      min-width: 420px;
      max-width: 520px;
      word-break: break-word;
    }

    .text-block {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
    }

    .text-content {
      position: relative;
      width: 100%;
      overflow: hidden;
    }

    .text-content.is-collapsed {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      line-clamp: 3;
      max-height: calc(1.55em * 3);
    }

    .text-content.is-collapsed::after {
      content: "";
      position: absolute;
      right: 0;
      bottom: 0;
      width: 35%;
      height: 1.55em;
      background: linear-gradient(90deg, rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.96) 70%);
      pointer-events: none;
    }

    .row-main .text-content.is-collapsed::after {
      background: linear-gradient(90deg, rgba(255, 245, 241, 0), rgba(255, 249, 247, 0.98) 70%);
    }

    .row-reply .text-content.is-collapsed::after {
      background: linear-gradient(90deg, rgba(250, 253, 255, 0), rgba(250, 253, 255, 0.98) 70%);
    }

    .text-content.is-expanded {
      max-height: none;
    }

    .text-toggle {
      padding: 0;
      border: 0;
      background: transparent;
      color: #0f5f73;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }

    .text-toggle:hover {
      text-decoration: underline;
    }

    .col-images {
      width: 220px;
    }

    .col-replies {
      width: 84px;
      text-align: center;
      white-space: nowrap;
      font-weight: 700;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 56px;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
    }

    .badge-main {
      background: var(--accent-soft);
      color: var(--accent);
    }

    .badge-reply {
      background: var(--reply-soft);
      color: var(--reply);
    }

    .user-name {
      font-weight: 700;
      line-height: 1.45;
      word-break: break-word;
    }

    .reply-to {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      word-break: break-word;
    }

    .thumb-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .thumb-link {
      width: 52px;
      height: 52px;
      overflow: hidden;
      border-radius: 10px;
      background: #edf2f7;
      border: 1px solid var(--line);
      flex: 0 0 auto;
    }

    .thumb-image {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .muted {
      color: var(--muted);
    }

    .empty-cell {
      padding: 28px 12px;
      text-align: center;
      color: var(--muted);
      background: #fff;
    }

    @media (max-width: 900px) {
      .page {
        width: min(100vw - 12px, 1560px);
        padding-top: 10px;
      }

      .hero {
        padding: 14px;
      }

      tbody td,
      thead th {
        padding: 9px 8px;
      }

      .thumb-link {
        width: 46px;
        height: 46px;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <div class="hero-top">
        <div>
          <span class="eyebrow">小红书评论表格展示</span>
          <h1>${escapeHtml(title)}</h1>
          <p class="hero-desc">适用于相同结构的评论 JSON 文件。页面按表格高密度展示主评论、回复、时间、地区、正文和图片缩略图，便于快速浏览。</p>
        </div>
        <div class="source-box">
          <span class="source-label">源文件</span>
          <div>${escapeHtml(sourceName)}</div>
          ${safeUrl ? `<span class="source-label" style="margin-top:8px;">原始链接</span><a class="source-link" href="${safeUrl}" target="_blank" rel="noreferrer">${safeUrl}</a>` : ""}
        </div>
      </div>

      <div class="stats">
        <div class="stat">
          <div class="stat-label">主评论数</div>
          <div class="stat-value">${items.length}</div>
        </div>
        <div class="stat">
          <div class="stat-label">回复总数</div>
          <div class="stat-value">${totalReplies}</div>
        </div>
        <div class="stat">
          <div class="stat-label">展示总行数</div>
          <div class="stat-value">${totalRows}</div>
        </div>
        <div class="stat">
          <div class="stat-label">图片总数</div>
          <div class="stat-value">${totalImages}</div>
        </div>
        <div class="stat">
          <div class="stat-label">JSON 标注总数</div>
          <div class="stat-value">${escapeHtml(data.total ?? items.length)}</div>
        </div>
      </div>
    </section>

    <section class="table-panel">
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>序号</th>
              <th>类型</th>
              <th>用户</th>
              <th>时间 / 地区</th>
              <th>内容</th>
              <th>图片</th>
              <th>回复数</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    function toggleText(button) {
      const content = button.previousElementSibling;
      if (!content) return;
      const expanded = content.classList.toggle("is-expanded");
      content.classList.toggle("is-collapsed", !expanded);
      button.textContent = expanded ? "收起" : "展开";
    }
  </script>
</body>
</html>`;
}

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    console.error(`读取或解析 JSON 失败: ${error.message}`);
    process.exit(1);
  }
}

function ensureValidShape(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.items)) {
    console.error("JSON 结构不符合预期，至少需要包含 items 数组。");
    process.exit(1);
  }
}

function getDefaultOutputPath(inputPath) {
  const ext = path.extname(inputPath);
  if (!ext) {
    return `${inputPath}.html`;
  }

  return inputPath.slice(0, -ext.length) + ".html";
}

function main() {
  const inputArg = process.argv[2] || DEFAULT_COMMENT_JSON_FILE;
  const inputPath = path.resolve(process.cwd(), inputArg);
  const outputArg = process.argv[3];
  const outputPath = outputArg ? path.resolve(process.cwd(), outputArg) : getDefaultOutputPath(inputPath);

  if (!fs.existsSync(inputPath)) {
    console.error(`找不到输入文件: ${inputPath}`);
    process.exit(1);
  }

  const data = readJson(inputPath);
  ensureValidShape(data);

  const html = buildHtml(data, inputPath);
  fs.writeFileSync(outputPath, html, "utf8");

  console.log(`HTML 已生成: ${outputPath}`);
}

main();
