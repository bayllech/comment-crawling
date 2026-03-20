# comment-crawling

用于把小红书评论 JSON 导出为更易读的本地文件。

当前仓库只保留本地导出能力，不再包含在线文档同步逻辑。

## 目录结构

```text
.
├── scripts/
│   ├── xhs-render-comments.js
│   ├── xhs-export-prompts.js
│   └── get-prompt-cli.js
├── lib/
│   ├── project-config.js
│   └── prompt-api-client.js
├── examples/
│   ├── xhs-comment-crawler.user.js
│   └── floating-panel-notes.txt
├── package.json
└── README.md
```

## 安装

```bash
npm install
```

## 可用命令

```bash
npm run comments:html
npm run xhs:export
npm run prompt:reverse
```

兼容旧命令：

```bash
npm run render
npm run xhs:auto
npm run xhs:prompts
npm run get-prompt:reverse
```

## 1. 评论转 HTML

默认扫描当前目录及子目录中的 JSON 文件：

```bash
npm run comments:html
```

指定输入和输出文件：

```bash
node scripts/xhs-render-comments.js ./你的评论文件.json ./输出页面.html
```

## 2. 图片提示词导出

一键导出图片、评论区提示词、反推提示词，并生成 `HTML + Excel`：

```bash
npm run xhs:export
```

或指定输入和输出目录：

```bash
node scripts/xhs-export-prompts.js ./xhs_comments.json ./xhs_comments-prompt-export
```

导出目录包含：

- `index.html`
- `index.xlsx`
- `images/`
- `rows.json`
- `.resume.json`

常用参数：

- `--user-code`
- `--lang`
- `--concurrency`
- `--skip-reverse`
- `--fresh`
- `--render-only`

## 3. 单图反推 CLI

```bash
npm run prompt:reverse -- --user-code 你的用户码 --image ./sample.jpg --lang English
```

## 环境变量

```bash
GET_PROMPT_BASE_URL=https://ai.yaokemao.com
GET_PROMPT_APP_CODE=w3BTlKW5onSybv38
GET_PROMPT_DEFAULT_LANG=English
GET_PROMPT_USER_CODE=260220
```

## 输入数据结构

输入 JSON 至少应包含：

```json
{
  "url": "笔记链接",
  "items": [
    {
      "index": 1,
      "comment": {
        "user": "用户名",
        "text": "评论正文",
        "time": "评论时间",
        "location": "地区",
        "images": ["图片地址"]
      },
      "replies": [
        {
          "user": "回复人",
          "replyTo": "被回复人",
          "text": "回复正文",
          "time": "回复时间",
          "location": "地区",
          "images": ["图片地址"]
        }
      ]
    }
  ]
}
```

## 说明

- HTML 可直接离线打开查看
- Excel 会把图片写入单元格区域
- 若源图格式对 Excel 兼容性较差，导出时会自动转成 `png`
- 导出脚本支持断点续跑
- 运行产物已在 `.gitignore` 中忽略，不需要提交导出目录
