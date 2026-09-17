# 公众号技术文章模板

这个目录保存可版本管理的公众号发布资产，不会改写 Vault 里的原始文章。渲染器是固定在 `vendor/doocs-md/` 的 [doocs/md](https://github.com/doocs/md) Git submodule；依赖目录不提交，克隆后按下方说明安装即可复现。

模板是 `tech-deep-dive`：深色首屏、固定文章目录、两级标题和结尾 CTA。微信 `draft/add` 会拒绝正文内 `id` / `name` / `href="#…"` 锚点，因此目录当前是静态导航；渲染器会拒绝输出这类会导致草稿创建失败的标记。模板统一输出自然数编号：一级章节为 `1.`、`2.`…，二级小节为 `1.1`、`1.2`…；源文档中手写的任意旧序号会被替换。所有文章都禁止使用 `01`、`02`、`03`、`01.1` 等补零编号，也禁止在文章中展示“解读版本”或“季度版本”元信息。正文一级章节是深色章节条，二级小节是浅蓝标签式标题；任何 fenced code 都会以深色、圆角、带代码块头部的独立代码卡片输出。它用 doocs/md 渲染正文，再用已安装的 `juice` 将 CSS 内联；这是避免公众号编辑器丢弃 `<style>` 后退化为纯文本排版的必要步骤。

## 初次安装

```sh
git submodule update --init --recursive
pnpm --dir vendor/doocs-md install --frozen-lockfile
```

需要 Node.js `>=22.22.2`（上游 doocs/md 的要求）、pnpm 和已配置好的 `md2wechat` CLI。微信凭据保持在本机配置中，绝不提交到这个仓库。

## 使用

生成并检查 HTML（无远程写入）：

```sh
pnpm --dir vendor/doocs-md/packages/mcp-server exec tsx \
  ../../../../scripts/wechat/publish-tech-draft.mts wiki/concepts/claude-obsidian-knowledge-system.md \
  --html /tmp/wechat-article.html
```

生成用于复核的文章 payload JSON（该文件不含公众号封面 `media_id`，因此不能直接提交）：

```sh
pnpm --dir vendor/doocs-md/packages/mcp-server exec tsx \
  ../../../../scripts/wechat/publish-tech-draft.mts <article.md> --draft-json /tmp/wechat-draft.json
```

创建公众号草稿（会上传封面并写入草稿箱）：

```sh
pnpm --dir vendor/doocs-md/packages/mcp-server exec tsx \
  ../../../../scripts/wechat/publish-tech-draft.mts <article.md> --draft --cover /absolute/path/to/cover.jpg
```

草稿完成后，回读公众号草稿确认首屏、文章目录、章节层级、CTA 和内联样式均存在。微信 `draft/add` API 通常只返回 `media_id`；若从后台得到可访问草稿链接，必须连同该 URL 一并交付。

## Codex SDK Agentic Loop

`wechat-agent` 是公众号生产 Harness：主 Agent 编排写作、视觉与 QA 三个受限 Codex SDK thread；正文始终由本目录的确定性 doocs/md 脚本渲染。`wechat-loop` 继续保留为旧流程兼容入口。首次使用安装其最小依赖：

```sh
pnpm --dir scripts/wechat install --frozen-lockfile
```

启动仅生成审阅包，不会上传或创建草稿：

```sh
pnpm --dir scripts/wechat wechat-agent improve <article.md> --vault /absolute/path/to/vault --goal "完善文章" --cover /absolute/path/to/cover.jpg
```

输出中的 `runId` 对应本工程 `.runtime/runs/<runId>/`：其中包含文章快照、HTML、移动端截图、QA、状态和事件。Vault 只通过 `--vault` 作为显式内容源，不保存运行产物。视觉检查通过后会停在 `awaiting_draft_approval`。只有以下命令会创建草稿：

```sh
pnpm --dir scripts/wechat wechat-agent approve-draft <runId>
```

使用 `status` / `report` 查看状态，使用 `resume` 继续同一个 Agent run。审批保护由 CLI 内部消费，使用者无需取得或输入 token。草稿接口没有返回 URL 时，以真实 `media_id` 交付；Harness 不会伪造草稿链接。

完整状态、权限和质量门禁见 [`PROTOCOL.md`](./PROTOCOL.md)。群发不属于这条流水线，脚本没有调用对应接口。
