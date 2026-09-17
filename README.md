# wechat-agent

独立的微信公众号文章生产工程。它只在命令行通过 `--vault /absolute/path/to/vault` 挂载 Obsidian Vault 作为内容源：原始 Markdown 只读，运行状态、HTML、截图、QA、图片资产与草稿回读均写入本工程的 `.runtime/runs/`。

```sh
pnpm --dir scripts/wechat wechat-agent improve \
  'Agent案例解析/ai-berkshire-harness-analysis.md' \
  --vault /Users/miller/Projects/obsidianVault \
  --goal '降低门槛，核验事实，补一张架构图' \
  --cover scripts/wechat/covers/ai-berkshire.svg
```

审阅通过后，用户明确要求创建草稿时执行：

```sh
pnpm --dir scripts/wechat wechat-agent approve-draft <run-id>
```

这条工程不包含群发能力。更多运行协议见 [scripts/wechat/PROTOCOL.md](scripts/wechat/PROTOCOL.md)。
