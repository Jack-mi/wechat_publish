# Codex SDK 公众号生产协议

`wechat-agent` 是本地、可恢复的公众号生产 Harness。主 Agent 只做编排；写作、视觉和 QA Agent 都通过只读 Codex SDK thread 输出结构化产物；doocs/md 与 `publish-tech-draft.mts` 是唯一的生产 HTML 渲染器。

## 状态、角色与权限

`intake → plan → research_and_write → awaiting_human_fact_resolution | visual_design → render → full_qa → revise | awaiting_draft_approval → draft_create | draft_update → post_draft_qa → completed | blocked`

- 主 Agent 计划、派单和裁决，不能写文章或操作公众号；写作 Agent 在 `workspace-write` 沙箱并开启网络下核验公开网页事实（该模式不挂载 Vault，Vault 始终保持只读），视觉与 QA Agent 在只读沙箱且禁用联网。所有 Agent 禁止直接上传、创建草稿或群发。
- 原始 Vault Markdown 永远只读；运行副本、来源、图解、截图、HTML、QA 和事件仅写入本工程 `.runtime/runs/<run-id>/`。只有 `export` 可将最终工作稿显式写回 Vault。
- 每个 Agent 的 SDK thread ID 记录于 `state.json`，`resume` 继续同一 run；所有 Agent 输出均须匹配 CLI schema。
- `approve-draft` 由用户的明确“创建草稿”意图触发，CLI 自动消费内部一次性保护；`update-draft` 只接受显式 `media_id`，不按标题匹配；无论任何阶段，都不调用群发/发布接口。

## 不可绕过 Hook

- 研究完成后，关键主张必须有 URL、抓取时间和摘录。任何影响核心结论、机制、关键数值/时间线或推荐的外部事实冲突，强制进入 `awaiting_human_fact_resolution`。
- 人工必须对每个重大冲突选择 `research_wins`、`retain_with_qualification` 或 `drop_claim`；存在未决冲突时，渲染、上传和草稿动作全部拒绝。
- 渲染后必须通过目录、H2/H3、自然编号、代码卡片、内联样式、禁止文案、封面和 390px 截图检查。目录是静态导航：微信草稿接口拒绝正文 `id`、`name` 和 `href="#…"` 锚点。
- 草稿前必须校验内部审批保护、QA、工作稿哈希、封面、无未决冲突和公众号预检。正文本地资产先转为 PNG、上传并写入 `publish/article.md` 的远程 URL，才会生成实际草稿 payload。
- 草稿创建/更新后必须 `draft/get` 回读标题、目录、首个 H2 和本地路径残留；接口未提供 URL 时，只交付真实 `media_id`。

## 草稿回读与恢复

- 创建草稿要求标题不超过 32 个字符（md2wechat 预检口径）。
- `approve-draft` 会在创建后回读 `draft/get`，校验标题、文章目录、首个 H2 和本地资产路径；微信实际把 `news_item` 放在响应顶层。
- `media_id` 在创建成功后立即落盘，回读失败不会丢号；用 `verify-draft <run-id>` 重跑回读校验即可把运行推进到 `completed`。
- 工作稿在 QA 后被改动时，`resume` 会自动重渲染并重新过 QA，再进入草稿审批。
