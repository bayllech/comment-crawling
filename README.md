# 小红书评论导出工具

这个仓库当前保留两类本地导出能力：

- `render-xhs-comments.js`：把评论 JSON 渲染成静态 HTML
- `extract-xhs-image-prompts.js`：下载评论图片、提取评论区提示词、调用反推接口，并导出 `HTML + Excel`

## 安装

```bash
npm install
```

## 评论转 HTML

默认会扫描当前目录及子目录中的 JSON 文件：

```bash
npm run render
```

也可以直接指定输入和输出文件：

```bash
node render-xhs-comments.js ./你的评论文件.json ./输出页面.html
```

## 图片提示词导出

一键入口：

```bash
npm run xhs:auto
```

或者直接执行：

```bash
node extract-xhs-image-prompts.js
```

也支持显式指定输入和输出目录：

```bash
node extract-xhs-image-prompts.js ./xhs_comments.json ./xhs_comments-prompt-export
```

导出目录内会生成：

- `index.html`
- `index.xlsx`
- `images/`
- `rows.json`
- `.resume.json`

## 常用参数

- `--user-code`：反推接口使用的用户码
- `--lang`：反推语言，默认 `简体中文`
- `--concurrency`：下载和反推并发数，默认 `2`
- `--skip-reverse`：只下载图片和提取评论区提示词，不执行反推
- `--fresh`：忽略断点记录，从头重新处理
- `--render-only`：只基于已有 `rows.json` / 本地图片重新生成 HTML 和 Excel

## 导出说明

- HTML 可直接离线打开查看
- Excel 会把图片写入单元格区域
- 如果图片格式对 Excel 兼容性较差，导出时会自动转成 `png`
- 脚本支持断点续跑，再次执行时会跳过已完成记录

## 环境变量

```bash
GET_PROMPT_BASE_URL=https://ai.yaokemao.com
GET_PROMPT_APP_CODE=w3BTlKW5onSybv38
GET_PROMPT_DEFAULT_LANG=English
GET_PROMPT_USER_CODE=260220
```

## 输入数据要求

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

## 版本管理

运行产物已在 `.gitignore` 中忽略，不需要提交导出目录。
