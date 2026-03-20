#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

function loadProjectEnv() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");

  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function parseArgs(argv) {
  const args = {
    baseUrl: "",
    appCode: "",
    lang: "",
    userCode: "",
    imagePath: "",
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      continue;
    }

    const [flag, inlineValue] = token.split("=", 2);
    const readValue = () => inlineValue ?? argv[index + 1];

    switch (flag) {
      case "--base-url":
        args.baseUrl = readValue();
        if (!inlineValue) index += 1;
        break;
      case "--app-code":
        args.appCode = readValue();
        if (!inlineValue) index += 1;
        break;
      case "--user-code":
        args.userCode = readValue();
        if (!inlineValue) index += 1;
        break;
      case "--lang":
        args.lang = readValue();
        if (!inlineValue) index += 1;
        break;
      case "--image":
        args.imagePath = readValue();
        if (!inlineValue) index += 1;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      default:
        break;
    }
  }

  return args;
}

function applyDefaults(args) {
  return {
    baseUrl: args.baseUrl || process.env.GET_PROMPT_BASE_URL || "https://ai.yaokemao.com",
    appCode: args.appCode || process.env.GET_PROMPT_APP_CODE || "w3BTlKW5onSybv38",
    lang: args.lang || process.env.GET_PROMPT_DEFAULT_LANG || "English",
    userCode: args.userCode || process.env.GET_PROMPT_USER_CODE || "260220",
    imagePath: args.imagePath || "",
    verbose: Boolean(args.verbose),
  };
}

function assertRequired(value, message) {
  if (!value || !String(value).trim()) {
    throw new Error(message);
  }
}

function mimeTypeFromFileName(fileName) {
  const ext = path.extname(fileName).toLowerCase();
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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload;

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`接口返回了非 JSON 内容：${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    throw new Error(`请求失败 ${response.status}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

async function getPassport({ baseUrl, appCode }) {
  const payload = await fetchJson(`${baseUrl}/api/passport?`, {
    method: "GET",
    headers: {
      "x-app-code": appCode,
      accept: "*/*",
    },
  });

  assertRequired(payload.access_token, "未获取到 access_token");
  return payload.access_token;
}

async function uploadImage({ baseUrl, appCode, passport, imagePath }) {
  const fileName = path.basename(imagePath);
  const buffer = await fs.readFile(imagePath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([buffer], { type: mimeTypeFromFileName(fileName) }),
    fileName
  );

  const payload = await fetchJson(`${baseUrl}/api/files/upload`, {
    method: "POST",
    headers: {
      "x-app-code": appCode,
      "x-app-passport": passport,
    },
    body: form,
  });

  assertRequired(payload.id, "未获取到上传文件 id");
  return payload;
}

function parseSseEvents(rawText) {
  const blocks = rawText
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const events = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let eventName = "";
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) {
      continue;
    }

    const dataText = dataLines.join("\n");
    let data;

    try {
      data = JSON.parse(dataText);
    } catch {
      data = dataText;
    }

    const normalizedEvent = eventName || (data && typeof data === "object" ? data.event : "") || "";
    events.push({ event: normalizedEvent, data });
  }

  return events;
}

async function runWorkflow({ baseUrl, appCode, passport, userCode, lang, uploadFileId }) {
  const response = await fetch(`${baseUrl}/api/workflows/run`, {
    method: "POST",
    headers: {
      "x-app-code": appCode,
      "x-app-passport": passport,
      "content-type": "application/json",
      accept: "*/*",
    },
    body: JSON.stringify({
      inputs: {
        user_code: userCode,
        lang,
      },
      files: [
        {
          type: "image",
          transfer_method: "local_file",
          url: "",
          upload_file_id: uploadFileId,
        },
      ],
      response_mode: "streaming",
    }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(`工作流执行失败 ${response.status}: ${rawText.slice(0, 500)}`);
  }

  const events = parseSseEvents(rawText);
  const finishedEvent = [...events].reverse().find((item) => item.event === "workflow_finished");
  const output = finishedEvent?.data?.data?.outputs || {};

  return {
    rawText,
    events,
    output,
  };
}

function extractPrompt(output) {
  if (!output || typeof output !== "object") {
    return "";
  }

  return (
    output.final_prompt ||
    output.prompt ||
    output.generated_prompt ||
    output.answer ||
    output.提示词 ||
    output.提示 ||
    output.生成提示词 ||
    output.反推提示词 ||
    ""
  );
}

export {
  assertRequired,
  applyDefaults,
  extractPrompt,
  fetchJson,
  getPassport,
  loadProjectEnv,
  mimeTypeFromFileName,
  parseArgs,
  parseSseEvents,
  runWorkflow,
  uploadImage,
};
