# 小红书评论 JSON 转 HTML

## 仓库说明

本仓库主要包含两类能力：

- `render-xhs-comments.js`：把小红书评论 JSON 渲染成可直接打开的静态 HTML
- `extract-xhs-image-prompts.js`：把评论里的图片、本地化导出结果和提示词提取出来

为避免版本库被运行产物污染，下面这些内容已经纳入忽略规则：

- `xhs_comments_*.html`
- `xhs_comments_*.json`
- `xhs_comments_*-prompt-export/`
- `**/.resume.json`
- `*.tmp`
- `test.jpg`

如果你后续新增自己的导出文件，建议继续沿用“源码入库、产物忽略”的方式管理。

## Get-Prompt 网页接口封装

`get-prompt.online` 实际上嵌入的是一个公开的 Dify 工作流页面，前端提交时会调用以下接口：

- `GET /api/passport?`：获取临时 `access_token`
- `POST /api/files/upload`：上传图片
- `POST /api/workflows/run`：执行工作流，返回 `text/event-stream`

当前已提取到的公开参数：

- `baseUrl`: `https://ai.yaokemao.com`
- `appCode`: `w3BTlKW5onSybv38`

工作流输入字段：

- `user_code`
- `lang`

图片上传字段：

- `files[0].type = image`
- `files[0].transfer_method = local_file`
- `files[0].upload_file_id = 上传返回的 id`

本仓库已提供一个可直接调用的 Node 封装：

```bash
node get-prompt-api.js --user-code 你的用户码 --image ./sample.jpg --lang English
```

也可以走 npm 脚本：

```bash
npm run get-prompt:reverse -- --user-code 你的用户码 --image ./sample.jpg --lang English
```

可选环境变量：

```bash
GET_PROMPT_BASE_URL=https://ai.yaokemao.com
GET_PROMPT_APP_CODE=w3BTlKW5onSybv38
GET_PROMPT_DEFAULT_LANG=English
GET_PROMPT_USER_CODE=260220
```

注意：

- 这个接口并不是纯匿名开放，`user_code` 仍然是业务侧校验项
- 如果 `user_code` 不正确，工作流会直接返回失败文本
- 我没有做任何绕过验证的处理，只封装了网页端实际使用的请求链路

## 用法

默认情况下会自动扫描当前目录及子目录里的 JSON 文件；如果只找到一个就直接处理，找到多个时会让你选择。也可以继续手动传入输入文件：

```bash
node render-xhs-comments.js
```

或者使用：

```bash
npm run render
```

指定输入文件：

```bash
node render-xhs-comments.js ./你的评论文件.json
```

指定输入和输出文件：

```bash
node render-xhs-comments.js ./你的评论文件.json ./输出页面.html
```

## 页面特点

- 使用高密度表格展示主评论和回复，一屏可以看到更多信息
- 表头固定，长列表滚动时仍然方便定位字段
- 图片使用缩略图展示，点击后可查看原图
- 自动统计主评论数、回复总数、展示总行数和图片总数

## 适用结构

适用于同一类评论 JSON 结构，至少包含以下字段：

```json
{
  "url": "笔记链接",
  "total": 68,
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

- `items` 必须存在且为数组
- `images` 支持字符串数组；如果后续图片项变成对象，脚本也会尝试从 `url`、`src` 等常见字段中取图
- 生成后的 HTML 是纯静态文件，浏览器直接打开即可查看
- 提取脚本默认输出到 `./<输入文件名>-prompt-export/`，目录内会生成 `index.html`、`rows.json`、`images/` 和断点文件 `.resume.json`
- 这些导出结果都已纳入 `.gitignore`，不会干扰源码版本管理

## 版本管理

建议的日常流程如下：

1. 修改脚本或文档
2. 运行 `git status`，确认只剩源码变更
3. 用 `git add` 和 `git commit` 记录一个清晰的版本点

如果只是重新导出数据，不需要把导出目录提交到仓库。

## 评论图片提示词提取

如果你的目标是把小红书评论里的图片、评论区提示词和反推提示词一起导出，建议直接使用一键入口：

```bash
npm run xhs:auto
```

或者：

```bash
node extract-xhs-image-prompts.js
```

运行后脚本会：

- 自动扫描当前目录及子目录里的 JSON 文件
- 在有多个候选时让你选一个，基本只需要输入编号
- 自动完成图片下载、评论区提示词提取、反推提示词
- 在终端显示进度条和当前阶段
- 最后输出完成提示，并告知你直接打开 `index.html` 即可查看

如果你想指定输入和输出目录，仍然支持原来的参数方式：

```bash
node extract-xhs-image-prompts.js ./xhs_comments.json ./xhs_comments-prompt-export
```

或者：

```bash
npm run xhs:prompts -- ./xhs_comments.json ./xhs_comments-prompt-export
```

输出内容：

- `index.html`：可离线打开的报告，图片已下载到本地目录
- `images/`：本地图片文件
- `rows.json`：结构化结果，便于二次处理

可选参数：

- `--user-code`：`get-prompt-api` 需要的用户码
- `--lang`：默认 `简体中文`
- `--concurrency`：下载和反推并发数，默认 `2`
- `--skip-reverse`：只下载图片和提取评论区提示词，不执行反推
- `--fresh`：忽略已有断点记录，从头重新处理

断点续跑说明：

- 脚本会在输出目录中自动写入 `.resume.json`
- 再次执行同一个输入文件和同一组配置时，会自动跳过已完成的图片记录，只继续处理剩余部分
- 如果你希望完全重跑，直接加上 `--fresh`

说明：

- 图片链接来自小红书 CDN，具有时效性，所以脚本会先把图片保存到本地
- 评论区提示词会优先从“同一作者、同一线程、连续的提示词分段”中合并
- 评论区提示词会在同一线程内优先收集更像提示词的评论文本，不再只认同一作者
- 反推提示词会默认使用 `user_code=260220`，并原样保留接口返回内容
- 如果找不到评论区提示词，导出结果会写 `无`
