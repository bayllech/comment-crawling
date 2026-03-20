#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";

const FEISHU_API_BASE = "https://open.feishu.cn/open-apis";
const FEISHU_RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function assertRequired(value, message) {
  if (!value || !String(value).trim()) {
    throw new Error(message);
  }
}

function safeUrlPathSegment(value) {
  return String(value ?? "").trim().replace(/^\/+|\/+$/g, "");
}

function parseFeishuTarget(target) {
  const raw = String(target ?? "").trim();
  if (!raw) {
    throw new Error("未提供飞书文档链接或文档 token");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return {
      raw,
      type: "doc",
      token: raw,
    };
  }

  const pathname = url.pathname || "";
  const queryToken = url.searchParams.get("token") || "";

  if (pathname.includes("/wiki/")) {
    const token = queryToken || pathname.split("/wiki/")[1]?.split("/")[0] || "";
    assertRequired(token, "无法从飞书 wiki 链接中解析节点 token");
    return {
      raw,
      type: "wiki",
      token,
    };
  }

  const docMatch = pathname.match(/\/docx\/([A-Za-z0-9]+)/) || pathname.match(/\/document\/([A-Za-z0-9]+)/);
  if (docMatch?.[1]) {
    return {
      raw,
      type: "doc",
      token: docMatch[1],
    };
  }

  if (queryToken) {
    return {
      raw,
      type: "wiki",
      token: queryToken,
    };
  }

  throw new Error(`暂不支持解析该飞书链接：${raw}`);
}

async function requestJson(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const maxAttempts = 5;
  let response;
  let text = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    response = await fetch(url, options);
    text = await response.text();

    if (!FEISHU_RETRY_STATUS.has(response.status)) {
      break;
    }

    if (attempt >= maxAttempts) {
      break;
    }

    await sleep(400 * attempt);
  }

  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`飞书接口返回了非 JSON 内容：${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`飞书请求失败 ${response.status} [${method} ${url}]: ${JSON.stringify(payload)}`);
  }

  if (payload && typeof payload === "object" && payload.code !== undefined && payload.code !== 0) {
    throw new Error(`飞书接口返回错误 ${payload.code} [${method} ${url}]: ${payload.msg || payload.message || "未知错误"}`);
  }

  return payload;
}

async function requestFormData(url, formData, options = {}) {
  const method = String(options.method || "POST").toUpperCase();
  const requestOptions = {
    method: "POST",
    ...options,
    body: formData,
  };
  const maxAttempts = 5;
  let response;
  let text = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    response = await fetch(url, requestOptions);
    text = await response.text();

    if (!FEISHU_RETRY_STATUS.has(response.status)) {
      break;
    }

    if (attempt >= maxAttempts) {
      break;
    }

    await sleep(400 * attempt);
  }

  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`飞书接口返回了非 JSON 内容：${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`飞书请求失败 ${response.status} [${method} ${url}]: ${JSON.stringify(payload)}`);
  }

  if (payload && typeof payload === "object" && payload.code !== undefined && payload.code !== 0) {
    throw new Error(`飞书接口返回错误 ${payload.code} [${method} ${url}]: ${payload.msg || payload.message || "未知错误"}`);
  }

  return payload;
}

async function getTenantAccessToken({ appId, appSecret }) {
  assertRequired(appId, "未配置 FEISHU_APP_ID");
  assertRequired(appSecret, "未配置 FEISHU_APP_SECRET");

  const payload = await requestJson(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      app_id: appId,
      app_secret: appSecret,
    }),
  });

  assertRequired(payload.tenant_access_token, "未获取到飞书 tenant_access_token");
  return payload.tenant_access_token;
}

async function getWikiNodeInfo({ token, accessToken }) {
  const payload = await requestJson(`${FEISHU_API_BASE}/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  const node = payload?.data?.node;
  assertRequired(node?.obj_token, "未从 wiki 节点中解析到文档 token");
  assertRequired(node?.obj_type, "未从 wiki 节点中解析到文档类型");

  return {
    spaceId: node.space_id || "",
    nodeToken: node.node_token || token,
    documentId: node.obj_token,
    documentType: node.obj_type,
    title: node.title || "",
  };
}

function isFeishuDocType(documentType) {
  return ["doc", "docx"].includes(String(documentType || "").toLowerCase());
}

async function listDocumentChildren({ documentId, parentId, accessToken, pageSize = 500 }) {
  const items = [];
  let pageToken = "";
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      document_revision_id: "-1",
      page_size: String(pageSize),
    });

    if (pageToken) {
      params.set("page_token", pageToken);
    }

    const payload = await requestJson(
      `${FEISHU_API_BASE}/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parentId)}/children?${params.toString()}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const data = payload?.data || {};
    const batch = Array.isArray(data.items) ? data.items : Array.isArray(data.children) ? data.children : [];
    items.push(...batch);

    hasMore = Boolean(data.has_more);
    pageToken = data.page_token || data.next_page_token || "";

    if (!batch.length) {
      break;
    }

    if (!hasMore) {
      break;
    }
  }

  return items;
}

async function deleteDocumentChildren({ documentId, parentId, accessToken }) {
  const children = await listDocumentChildren({ documentId, parentId, accessToken });

  if (children.length === 0) {
    return 0;
  }

  await requestJson(
    `${FEISHU_API_BASE}/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parentId)}/children/batch_delete`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        start_index: 0,
        end_index: children.length,
      }),
    }
  );

  return children.length;
}

function splitTextIntoBlocks(text, maxLength = 90000) {
  const raw = String(text ?? "");
  if (!raw) {
    return [""];
  }

  const chunks = [];
  for (let start = 0; start < raw.length; start += maxLength) {
    chunks.push(raw.slice(start, start + maxLength));
  }

  return chunks.length ? chunks : [raw];
}

function normalizePlainText(value, fallback = "") {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
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

function buildTextRunBlock(content, textElementStyle = {}) {
  return {
    block_type: 2,
    text: {
      elements: [
        {
          text_run: {
            content,
            text_element_style: textElementStyle,
          },
        },
      ],
      style: {},
    },
  };
}

function buildHeadingBlock(title) {
  return {
    block_type: 3,
    heading1: {
      elements: [
        {
          text_run: {
            content: title,
          },
        },
      ],
      style: {},
    },
  };
}

function buildParagraphBlock(content) {
  return buildTextRunBlock(content);
}

function buildStyledParagraphBlock(content, textElementStyle = {}) {
  return buildTextRunBlock(content, textElementStyle);
}

function buildSpacerBlock() {
  return buildParagraphBlock(" ");
}

function chunkArray(items, size) {
  const source = Array.isArray(items) ? items : [];
  const chunks = [];

  for (let index = 0; index < source.length; index += size) {
    chunks.push(source.slice(index, index + size));
  }

  return chunks;
}

let feishuBlockIdSeed = 0;

function createFeishuBlockId(prefix = "block") {
  feishuBlockIdSeed += 1;
  return `${prefix}_${Date.now()}_${feishuBlockIdSeed}`;
}

function attachBlockId(block, prefix = "block") {
  if (!block || typeof block !== "object") {
    return block;
  }

  if (typeof block.block_id === "string" && block.block_id.trim()) {
    return block;
  }

  return {
    ...block,
    block_id: createFeishuBlockId(prefix),
  };
}

function normalizeBlockChildren(children = []) {
  if (!Array.isArray(children)) {
    return [];
  }

  return children
    .map((child) => {
      if (typeof child === "string") {
        return child.trim();
      }

      if (child && typeof child === "object" && typeof child.block_id === "string") {
        return child.block_id.trim();
      }

      return "";
    })
    .filter(Boolean);
}

function buildLabelValueBlock(label, value, fallback = " - ") {
  return buildParagraphBlock(`${label}：${normalizePlainText(value, fallback)}`);
}

function buildMultiLineTextBlocks(title, lines = []) {
  const blocks = [buildHeadingBlock(title)];
  for (const line of lines) {
    blocks.push(...splitTextIntoBlocks(line).map((chunk) => buildParagraphBlock(chunk)));
  }
  blocks.push(buildSpacerBlock());
  return blocks;
}

function buildCodeBlock(codeText, language = "HTML") {
  return {
    block_type: 14,
    code: {
      elements: [
        {
          text_run: {
            content: String(codeText ?? ""),
            text_element_style: {},
          },
        },
      ],
      language,
      wrap_content: true,
    },
  };
}

function buildCodeBlocks(codeText, language = "HTML", maxLength = 90000) {
  // 飞书对单个文本块有长度上限，这里按安全长度拆成多个代码块。
  return splitTextIntoBlocks(codeText, maxLength).map((chunk) => buildCodeBlock(chunk, language));
}

function buildImageBlock() {
  return {
    block_type: 27,
    image: {},
  };
}

function buildTableCellBlock(children = []) {
  return {
    block_id: createFeishuBlockId("table_cell"),
    block_type: 32,
    table_cell: {},
    children: normalizeBlockChildren(children),
  };
}

function buildTableBlock({ rowSize, columnSize, columnWidth = [], children = [] }) {
  return {
    block_type: 31,
    table: {
      property: {
        row_size: rowSize,
        column_size: columnSize,
      },
    },
  };
}

function normalizeUploadedFileToken(payload) {
  return (
    payload?.data?.file_token ||
    payload?.data?.token ||
    payload?.data?.fileToken ||
    payload?.file_token ||
    payload?.token ||
    payload?.fileToken ||
    ""
  );
}

function mimeTypeFromFileName(fileName = "") {
  const ext = path.extname(String(fileName)).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
    default:
      return "image/jpeg";
  }
}

function findCreatedBlocks(payload, predicate) {
  const results = [];
  const seen = new Set();

  function walk(value) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    if (typeof value.block_id === "string" && predicate(value)) {
      results.push(value);
    }

    for (const nested of Object.values(value)) {
      walk(nested);
    }
  }

  walk(payload);
  return results;
}

function extractImageBlockIds(payload) {
  return findCreatedBlocks(payload, (block) => block.block_type === 27 && typeof block.block_id === "string").map((block) => block.block_id);
}

function extractTableInfo(payload) {
  const tableBlock = findCreatedBlocks(payload, (block) => block.block_type === 31 && typeof block.block_id === "string")[0];
  if (!tableBlock) {
    return null;
  }

  const cellIds = Array.isArray(tableBlock?.children) && tableBlock.children.length > 0
    ? tableBlock.children
    : Array.isArray(tableBlock?.table?.cells) ? tableBlock.table.cells : [];

  return {
    tableBlockId: tableBlock.block_id,
    cellIds: cellIds.filter((item) => typeof item === "string" && item.trim()),
  };
}

async function uploadDocumentImage({ documentId, parentNode, accessToken, imagePath }) {
  assertRequired(documentId, "未提供 documentId");
  assertRequired(parentNode, "未提供图片块 parentNode");
  assertRequired(accessToken, "未提供 accessToken");
  assertRequired(imagePath, "未提供图片路径");

  const absolutePath = path.resolve(imagePath);
  const buffer = await fs.readFile(absolutePath);
  const fileName = path.basename(absolutePath);
  const parentType = "docx_image";
  const form = new FormData();
  form.append("file_name", fileName);
  form.append("parent_type", parentType);
  form.append("parent_node", parentNode);
  form.append("size", String(buffer.length));
  form.append("file", new Blob([buffer], { type: mimeTypeFromFileName(fileName) }), fileName);

  let payload;
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      payload = await requestFormData(`${FEISHU_API_BASE}/drive/v1/medias/upload_all`, form, {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const shouldRetry = message.includes("1061044") || message.includes("parent node not exist");
      if (!shouldRetry || attempt >= 6) {
        throw error;
      }
      await sleep(500 * attempt);
    }
  }

  if (!payload && lastError) {
    throw lastError;
  }

  const fileToken = normalizeUploadedFileToken(payload);
  assertRequired(fileToken, "未从飞书上传素材接口获取到 file_token");
  return fileToken;
}

async function patchImageBlockToken({ documentId, blockId, accessToken, token }) {
  assertRequired(documentId, "未提供 documentId");
  assertRequired(blockId, "未提供图片块 blockId");
  assertRequired(accessToken, "未提供 accessToken");
  assertRequired(token, "未提供图片 token");

  await requestJson(`${FEISHU_API_BASE}/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      replace_image: {
        token,
      },
    }),
  });
}

async function getDocumentBlock({ documentId, blockId, accessToken }) {
  assertRequired(documentId, "未提供 documentId");
  assertRequired(blockId, "未提供 blockId");
  assertRequired(accessToken, "未提供 accessToken");

  const payload = await requestJson(`${FEISHU_API_BASE}/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  return payload?.data?.block || payload?.data || null;
}

async function waitForDocumentBlockReady({ documentId, blockId, accessToken, expectedType, maxAttempts = 12 }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const block = await getDocumentBlock({ documentId, blockId, accessToken });
      if (block && (!expectedType || block.block_type === expectedType)) {
        return block;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const shouldRetry = message.includes("99991663") || message.includes("not found") || message.includes("invalid param");
      if (!shouldRetry && attempt >= maxAttempts) {
        throw error;
      }
    }

    await sleep(500 * attempt);
  }

  throw new Error(`等待飞书块可用超时：${blockId}`);
}

function buildCommentThreadBlocks(item, index) {
  const comment = item?.comment || {};
  const replies = Array.isArray(item?.replies) ? item.replies : [];
  const commentImages = normalizeImages(comment.images);

  const blocks = [
    ...buildMultiLineTextBlocks(`评论 ${index}`, [
      `用户：${normalizePlainText(comment.user, "匿名用户")}`,
      `时间：${normalizePlainText(comment.time, " - ")}`,
      `地区：${normalizePlainText(comment.location, " - ")}`,
      `回复数：${replies.length}`,
      `图片数：${commentImages.length}`,
      `正文：${normalizePlainText(comment.text, "无正文")}`,
    ]),
  ];

  if (commentImages.length > 0) {
    blocks.push(buildHeadingBlock("图片"));
    commentImages.forEach((src, imageIndex) => {
      blocks.push(buildParagraphBlock(`图片 ${imageIndex + 1}：${src}`));
    });
    blocks.push(buildSpacerBlock());
  }

  if (replies.length > 0) {
    blocks.push(buildHeadingBlock("回复"));
    replies.forEach((reply, replyIndex) => {
      const replyImages = normalizeImages(reply?.images);
      blocks.push(
        ...buildMultiLineTextBlocks(`回复 ${replyIndex + 1}`, [
          `用户：${normalizePlainText(reply?.user, "匿名用户")}`,
          reply?.replyTo ? `回复对象：${normalizePlainText(reply.replyTo)}` : "",
          `时间：${normalizePlainText(reply?.time, " - ")}`,
          `地区：${normalizePlainText(reply?.location, " - ")}`,
          `正文：${normalizePlainText(reply?.text, "无正文")}`,
        ].filter(Boolean))
      );

      if (replyImages.length > 0) {
        blocks.push(...buildMultiLineTextBlocks("回复图片", replyImages.map((src, imageIndex) => `图片 ${imageIndex + 1}：${src}`)));
      }
    });
  }

  return blocks;
}

function buildCommentFeishuBlocks({ title, sourceFile, sourceUrl, items = [], summary = {} }) {
  const totalReplies = Number(summary.totalReplies ?? 0) || 0;
  const totalImages = Number(summary.totalImages ?? 0) || 0;
  const totalThreads = Array.isArray(items) ? items.length : 0;
  const blocks = [
    buildHeadingBlock(title || "小红书评论导出"),
    buildLabelValueBlock("源文件", sourceFile || "未知"),
    buildLabelValueBlock("原始链接", sourceUrl || " - "),
    buildLabelValueBlock("导出时间", new Date().toLocaleString("zh-CN", { hour12: false })),
    buildLabelValueBlock("主评论数", totalThreads),
    buildLabelValueBlock("回复数", totalReplies),
    buildLabelValueBlock("图片数", totalImages),
    buildSpacerBlock(),
  ];

  items.forEach((item, index) => {
    blocks.push(...buildCommentThreadBlocks(item, index + 1));
  });

  return blocks;
}

function buildPromptRowBlocks(row, index) {
  const blocks = [
    ...buildMultiLineTextBlocks(`图片记录 ${index}`, [
      `线程：${normalizePlainText(row.threadIndex, " - ")}`,
      `用户：${normalizePlainText(row.user, "匿名用户")}`,
      `类型：${normalizePlainText(row.kind, " - ")}`,
      row.imageTotal ? `图片序号：${normalizePlainText(row.imageIndex, " - ")}/${normalizePlainText(row.imageTotal, " - ")}` : "",
      `状态：${normalizePlainText(row.status, " - ")}`,
      `评论区提示词：${normalizePlainText(row.originalPrompt, "无")}`,
      row.reverseError
        ? `反推结果：失败 - ${normalizePlainText(row.reverseError, "")}`
        : `反推结果：${normalizePlainText(row.reversePrompt, "待补抓")}`,
    ].filter(Boolean)),
  ];

  if (row.localImageRel) {
    blocks.push(buildParagraphBlock(`本地图片：${normalizePlainText(row.localImageRel)}`));
  }

  blocks.push(buildSpacerBlock());
  return blocks;
}

function buildPromptTableTextBlocks(text, options = {}) {
  const rawText = normalizePlainText(text, "无");
  const bold = Boolean(options.bold);
  const chunks = splitTextIntoBlocks(rawText, options.maxLength || 12000);

  return chunks.map((chunk) => attachBlockId(buildStyledParagraphBlock(chunk, bold ? { bold: true } : {}), "table_text"));
}

function buildPromptTableCell(children = []) {
  return buildTableCellBlock(children);
}

function buildPromptTableHeaderCell(text) {
  return buildPromptTableCell([
    attachBlockId(buildStyledParagraphBlock(normalizePlainText(text, " - "), { bold: true }), "table_text"),
  ]);
}

function buildPromptTableTextCell(text, options = {}) {
  const children = buildPromptTableTextBlocks(text, options);
  return buildPromptTableCell(children.length > 0 ? children : [buildParagraphBlock(" - ")]);
}

function buildPromptTableImageCell(row) {
  return {
    kind: "image",
    imagePath: row.localImageAbs || "",
    fallbackText: row.localImageAbs ? "" : row.status === "error" ? "图片缺失" : "处理中",
  };
}

function buildPromptTableData(rows = []) {
  const tableRows = Array.isArray(rows) ? rows : [];

  if (tableRows.length === 0) {
    return null;
  }

  return {
    columns: ["序列", "用户", "图片", "评论区提示词", "反推提示词"],
    columnWidth: [90, 220, 260, 700, 700],
    rows: tableRows.map((row, index) => {
      const reverseText = row.reverseError
        ? `失败：${normalizePlainText(row.reverseError, "")}`
        : normalizePlainText(row.reversePrompt, "待补抓");
      const userMeta = `${normalizePlainText(row.kind, " - ")} · 线程 ${normalizePlainText(row.threadIndex, " - ")}${
        row.imageTotal > 1 ? ` · 第 ${normalizePlainText(row.imageIndex, " - ")}/${normalizePlainText(row.imageTotal, " - ")} 张` : ""
      }`;

      return [
        {
          kind: "text",
          lines: [String(index + 1)],
        },
        {
          kind: "text",
          lines: [
            normalizePlainText(row.user, "匿名用户"),
            userMeta,
          ],
          boldFirstLine: true,
        },
        buildPromptTableImageCell(row),
        {
          kind: "text",
          lines: [normalizePlainText(row.originalPrompt, "无")],
        },
        {
          kind: "text",
          lines: [reverseText],
        },
      ];
    }),
  };
}

function buildPromptFeishuBlocks({ title, sourceFile, sourceUrl, rows = [], meta = {} }) {
  const promptRows = Number(meta.promptRows ?? 0) || 0;
  const reverseOkRows = Number(meta.reverseOkRows ?? 0) || 0;
  const reverseFailRows = Number(meta.reverseFailRows ?? 0) || 0;
  const totalRows = Number(meta.totalRows ?? rows.length) || rows.length;

  const summaryBlocks = [
    buildHeadingBlock(title || "小红书评论图片提示词提取结果"),
    buildLabelValueBlock("源文件", sourceFile || "未知"),
    buildLabelValueBlock("原始链接", sourceUrl || " - "),
    buildLabelValueBlock("导出时间", new Date().toLocaleString("zh-CN", { hour12: false })),
    buildLabelValueBlock("图片条数", totalRows),
    buildLabelValueBlock("带评论区提示词", promptRows),
    buildLabelValueBlock("反推成功", reverseOkRows),
    buildLabelValueBlock("失败/待补抓", reverseFailRows),
    buildSpacerBlock(),
  ];
  const table = buildPromptTableData(rows);

  return {
    blocks: table ? summaryBlocks : [...summaryBlocks, buildParagraphBlock("暂无可导出的图片记录"), buildSpacerBlock()],
    table,
    imageUploads: [],
  };
}

function buildTableCellContentBlocks(cell, prefix = "table_text") {
  if (!cell || typeof cell !== "object") {
    return [attachBlockId(buildParagraphBlock(" - "), prefix)];
  }

  if (cell.kind === "text") {
    const sourceLines = Array.isArray(cell.lines) ? cell.lines : [];
    const lines = sourceLines.length > 0 ? sourceLines : [" - "];
    return lines.flatMap((line, index) => {
      const chunks = splitTextIntoBlocks(normalizePlainText(line, " - "), 12000);
      return chunks.map((chunk) => attachBlockId(
        buildStyledParagraphBlock(chunk, cell.boldFirstLine && index === 0 ? { bold: true } : {}),
        prefix
      ));
    });
  }

  if (cell.kind === "image" && !cell.imagePath) {
    return [attachBlockId(buildParagraphBlock(normalizePlainText(cell.fallbackText, "图片缺失")), prefix)];
  }

  return [];
}

async function fillPromptTable({
  documentId,
  parentId,
  accessToken,
  table,
  index = 0,
}) {
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows) || table.rows.length === 0) {
    return null;
  }

  const columnSize = table.columns.length;
  let currentIndex = index;
  const tableMetas = [];

  async function createSingleRowTable(rowCells) {
    const createResponses = await insertDocumentBlocks({
      documentId,
      parentId,
      accessToken,
      index: currentIndex,
      blocks: [
        buildTableBlock({
          rowSize: 1,
          columnSize,
        }),
      ],
    });
    currentIndex += 1;

    const tableInfo = createResponses.map(extractTableInfo).find(Boolean);
    if (!tableInfo || tableInfo.cellIds.length < columnSize) {
      throw new Error(`飞书行表格创建成功，但未拿到完整单元格 ID，期望 ${columnSize} 个，实际 ${tableInfo?.cellIds?.length || 0} 个`);
    }

    for (let cellIndex = 0; cellIndex < rowCells.length; cellIndex += 1) {
      const cell = rowCells[cellIndex];
      const cellId = tableInfo.cellIds[cellIndex];
      const contentBlocks = buildTableCellContentBlocks(cell);

      if (contentBlocks.length > 0) {
        await insertDocumentBlocks({
          documentId,
          parentId: cellId,
          accessToken,
          blocks: contentBlocks,
          index: 0,
        });
      }

      if (cell?.kind === "image" && cell.imagePath) {
        const imageCreateResponses = await insertDocumentBlocks({
          documentId,
          parentId: cellId,
          accessToken,
          blocks: [attachBlockId(buildImageBlock(), "table_image")],
          index: 0,
        });
        const imageBlockId = imageCreateResponses.flatMap((payload) => extractImageBlockIds(payload))[0];
        assertRequired(imageBlockId, "未能在表格单元格中创建图片块");
        await waitForDocumentBlockReady({
          documentId,
          blockId: imageBlockId,
          accessToken,
          expectedType: 27,
        });

        const fileToken = await uploadDocumentImage({
          documentId,
          parentNode: imageBlockId,
          accessToken,
          imagePath: cell.imagePath,
        });
        await patchImageBlockToken({
          documentId,
          blockId: imageBlockId,
          accessToken,
          token: fileToken,
        });
      }
    }

    tableMetas.push({
      tableBlockId: tableInfo.tableBlockId,
      columnSize,
    });
  }

  await createSingleRowTable(table.columns.map((title) => ({ kind: "text", lines: [title], boldFirstLine: true })));
  for (const row of table.rows) {
    await createSingleRowTable(row);
  }

  return {
    tableCount: tableMetas.length,
    columnSize,
  };
}

async function insertDocumentBlocks({ documentId, parentId, accessToken, blocks, index = 0 }) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return [];
  }

  const maxChildrenPerRequest = 50;
  const blockChunks = chunkArray(blocks, maxChildrenPerRequest);
  let currentIndex = index;
  const responses = [];

  // 飞书文档接口对单次 children 数组长度有限制，必须分批写入。
  for (const chunk of blockChunks) {
    const payload = await requestJson(`${FEISHU_API_BASE}/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parentId)}/children`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        index: currentIndex,
        children: chunk,
      }),
    });
    responses.push(payload);

    currentIndex += chunk.length;
  }

  return responses;
}

async function syncHtmlToFeishu({
  targetUrl,
  html,
  blocks,
  table,
  imageUploads = [],
  title,
  sourceFile,
  sourceUrl,
  appId,
  appSecret,
  mode = "overwrite",
}) {
  assertRequired(html || (Array.isArray(blocks) && blocks.length > 0), "没有可同步的内容");
  const target = parseFeishuTarget(targetUrl);
  const accessToken = await getTenantAccessToken({ appId, appSecret });

  let documentId = target.token;
  let targetTitle = title || "";

  if (target.type === "wiki") {
    const nodeInfo = await getWikiNodeInfo({ token: target.token, accessToken });
    if (!isFeishuDocType(nodeInfo.documentType)) {
      throw new Error(`当前 wiki 节点指向的不是文档类型，而是：${nodeInfo.documentType}。当前仅支持 doc / docx。`);
    }
    documentId = nodeInfo.documentId;
    if (!targetTitle) {
      targetTitle = nodeInfo.title || "";
    }
  }

  const resolvedTitle = targetTitle || "小红书内容导出";
  const normalizedMode = mode === "append" ? "append" : "overwrite";
  let insertIndex = 0;

  if (normalizedMode === "overwrite") {
    // 覆盖模式：先清空原有内容，再写入最新导出结果。
    await deleteDocumentChildren({ documentId, parentId: documentId, accessToken });
  } else {
    // 追加模式：写入到文档末尾，不破坏历史内容。
    const existingChildren = await listDocumentChildren({ documentId, parentId: documentId, accessToken });
    insertIndex = existingChildren.length;
  }

  const createdAt = new Date().toLocaleString("zh-CN", {
    hour12: false,
  });

  const contentBlocks = Array.isArray(blocks) && blocks.length > 0
    ? blocks
    : [
        buildTextRunBlock(`标题：${resolvedTitle}`),
        buildTextRunBlock(`源文件：${sourceFile || "未知"}`),
        sourceUrl ? buildTextRunBlock(`原始链接：${sourceUrl}`) : null,
        buildTextRunBlock(`同步时间：${createdAt}`),
        ...buildCodeBlocks(html, "HTML"),
      ].filter(Boolean);

  const createResponses = await insertDocumentBlocks({
    documentId,
    parentId: documentId,
    accessToken,
    blocks: contentBlocks,
    index: insertIndex,
  });

  if (table && Array.isArray(table.rows) && table.rows.length > 0) {
    await fillPromptTable({
      documentId,
      parentId: documentId,
      accessToken,
      table,
      index: insertIndex + contentBlocks.length,
    });
  }

  const pendingImageUploads = Array.isArray(imageUploads)
    ? imageUploads.filter((item) => item && item.imagePath)
    : [];

  if (pendingImageUploads.length > 0) {
    const imageBlockIds = createResponses.flatMap((payload) => extractImageBlockIds(payload));
    if (imageBlockIds.length < pendingImageUploads.length) {
      throw new Error(`创建的图片块数量不足，期望 ${pendingImageUploads.length} 个，实际 ${imageBlockIds.length} 个`);
    }

    for (let imageIndex = 0; imageIndex < pendingImageUploads.length; imageIndex += 1) {
      const uploadItem = pendingImageUploads[imageIndex];
      const imageBlockId = imageBlockIds[imageIndex];
      const fileToken = await uploadDocumentImage({
        documentId,
        parentNode: imageBlockId,
        accessToken,
        imagePath: uploadItem.imagePath,
      });
      await patchImageBlockToken({
        documentId,
        blockId: imageBlockId,
        accessToken,
        token: fileToken,
      });
    }
  }

  return {
    documentId,
    documentTitle: resolvedTitle,
    nodeType: target.type,
    mode: normalizedMode,
  };
}

export {
  buildCodeBlock,
  buildCodeBlocks,
  buildImageBlock,
  buildCommentFeishuBlocks,
  buildLabelValueBlock,
  buildHeadingBlock,
  buildParagraphBlock,
  buildStyledParagraphBlock,
  buildTableBlock,
  buildTableCellBlock,
  buildPromptFeishuBlocks,
  buildSpacerBlock,
  buildTextRunBlock,
  deleteDocumentChildren,
  getTenantAccessToken,
  patchImageBlockToken,
  getWikiNodeInfo,
  insertDocumentBlocks,
  listDocumentChildren,
  parseFeishuTarget,
  uploadDocumentImage,
  syncHtmlToFeishu,
};
