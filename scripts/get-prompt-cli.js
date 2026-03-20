#!/usr/bin/env node

import {
  applyDefaults,
  assertRequired,
  extractPrompt,
  getPassport,
  loadProjectEnv,
  parseArgs,
  runWorkflow,
  uploadImage,
} from "../lib/prompt-api-client.js";

function printUsage() {
  console.log([
    "用法：",
    "  node scripts/get-prompt-cli.js --user-code <用户码> --image <图片路径> [--lang English|简体中文]",
    "",
    "环境变量：",
    "  GET_PROMPT_BASE_URL    默认 https://ai.yaokemao.com",
    "  GET_PROMPT_APP_CODE    默认 w3BTlKW5onSybv38",
    "  GET_PROMPT_DEFAULT_LANG 默认 English",
    "  GET_PROMPT_USER_CODE   可选，作为 --user-code 的默认值，默认 260220",
  ].join("\n"));
}

async function main() {
  loadProjectEnv();

  const args = applyDefaults(parseArgs(process.argv.slice(2)));
  if (process.argv.slice(2).includes("--help") || process.argv.slice(2).includes("-h")) {
    printUsage();
    return;
  }

  assertRequired(args.imagePath, "缺少 --image");

  const passport = await getPassport(args);
  const uploaded = await uploadImage({ ...args, passport });
  const result = await runWorkflow({
    ...args,
    passport,
    uploadFileId: uploaded.id,
  });

  const failureText = result.output?.wrong;
  if (failureText) {
    console.log(JSON.stringify({
      ok: false,
      message: failureText,
      prompt: extractPrompt(result.output),
      upload: uploaded,
      output: result.output,
    }, null, 2));
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    prompt: extractPrompt(result.output),
    upload: uploaded,
    output: result.output,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
