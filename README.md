# comment-crawling

用于把小红书评论 JSON 导出为本地可读文件，重点是 `xhs:auto` 一键导出流程。

## 安装

```bash
npm install
```

## 一键 Auto 导出

最常用的方式就是直接跑：

```bash
npm run xhs:auto
```

这个命令会自动做这些事：

- 自动寻找输入 JSON
- 导出图片、HTML、Excel、`rows.json`
- 生成断点恢复文件，支持再次运行时续跑

如果当前目录下有多个 JSON 文件，会先让你选择；如果只有一个，就直接使用。

常用写法：

```bash
npm run xhs:auto -- --input ./xhs_comments.json
npm run xhs:auto -- --input ./xhs_comments.json --output ./xhs_comments-prompt-export
npm run xhs:auto -- --input ./xhs_comments.json --fresh
npm run xhs:auto -- --input ./xhs_comments.json --skip-reverse
npm run xhs:auto -- --input ./xhs_comments.json --render-only
```

常用参数：

- `--input`：指定输入 JSON
- `--output`：指定输出目录
- `--concurrency`：控制并发数
- `--lang`：反推提示词语言
- `--skip-reverse`：跳过反推提示词
- `--render-only`：只渲染 HTML，不执行完整导出
- `--fresh`：忽略断点，重新开始
- `--resume`：继续上次进度

兼容旧命令：

```bash
npm run xhs:export
npm run xhs:prompts
```

## 其他命令

### 评论转 HTML

```bash
npm run comments:html
```

也可以手动指定：

```bash
node scripts/xhs-render-comments.js ./你的评论文件.json ./输出页面.html
```

### 单图反推

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

## 输入数据

输入 JSON 至少包含下面这些字段：

```jsonc
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

## 输出说明

- `index.html`：本地浏览查看
- `index.xlsx`：Excel 表格
- `images/`：导出图片
- `rows.json`：标准化后的中间结果
- `.resume.json`：断点恢复状态

## 备注

- 源图不兼容 Excel 时会自动转成 `png`
- 导出结果已加入 `.gitignore`，不需要提交
