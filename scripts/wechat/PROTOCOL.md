# Codex SDK 公众号生产协议

`wechat-agent` 是本地、可恢复的公众号生产 Harness。主 Agent 只做编排；写作、编辑润色、视觉和 QA Agent 分别通过独立、受限的 Codex SDK thread 输出结构化产物；doocs/md 与 `publish-tech-draft.mts` 是唯一的生产 HTML 渲染器。

## 状态、角色与权限

`intake → plan → outline_review → research_and_write → awaiting_human_fact_resolution | structure_review → style_review → visual_design → render → full_qa → revise | awaiting_draft_approval → draft_create | draft_update → post_draft_qa → completed | blocked`

- 主 Agent 计划、派单和裁决，不能写文章或操作公众号；写作 Agent 在 `workspace-write` 沙箱并开启网络下核验公开网页事实（该模式不挂载 Vault，Vault 始终保持只读）；独立编辑 Agent 负责内容校验、去 AI 味、润色和格式、语气、风格统一；视觉与 QA Agent 继续独立验收。编辑、视觉与 QA Agent 均只读且禁用联网。所有 Agent 禁止直接上传、创建草稿或群发。
- 原始 Vault Markdown 永远只读；运行副本、来源、图解、截图、HTML、QA 和事件仅写入本工程 `.runtime/runs/<run-id>/`。只有 `export` 可将最终工作稿显式写回 Vault。
- 每个 Agent 的 SDK thread ID 记录于 `state.json`，`resume` 继续同一 run；所有 Agent 输出均须匹配 CLI schema。
- `approve-draft` 由用户的明确“创建草稿”意图触发，CLI 将批准的动作与目标写入运行状态；`update-draft` 只接受显式 `media_id`，不按标题匹配；无论任何阶段，都不调用群发/发布接口。
- 创建 run 时固化 `executionMode=real|mock`。后续执行、审批和回读必须与 `WECHAT_AGENT_MOCK` 一致，禁止把 mock 产物切换成真实发布，或用 mock 回读把真实草稿标记为成功。mock 发布不调用公众号或凭据预检。
- 旧 run 缺少 `executionMode` 时显示 `unknown`，不自动推断或升级。它们仍可 `status` / `report` / `preview`；已有非 mock `media_id` 的旧草稿可在真实环境执行 `verify-draft`。重新生产需新建 run，不手改历史状态。

## 修订与验收补充

- 新稿保持完整角色链。局部修订始终先过全局确定性门禁和范围/资产指纹：纯参考来源、固定模板行删除走确定性验收；只改 H1 后、首个 H2 前自然开场且其余正文、章节、图片、封面未变时走首屏专项视觉 QA；其他 image/layout/content/style 修订仍走全篇视觉 QA。范围外文字、资产和引用由哈希或精确差异锁定。
- `writingFinal` 指向不可覆盖的 UUID 版本文件；各角色输入输出和每次 JSON 产物另存历史。旧事实基准不再覆盖当前稿，新的 QA 修复返回精确替换而非全文重写。
- `targeted_revision` 只修当前 QA 列出的所有问题。审美建议使用非阻断等级。范围锁定的小修遇到新问题停止并等待新的显式补丁，不擅自改正文。
- 真实 Chrome 使用390px设备视口并实测完整文档高度，始终检查溢出、标题孤行和图片加载。全篇视觉 QA 发送首屏、重叠分段和封面；开场专项只采集首屏和封面；纯确定性修订不调用模型。不能用估计文件大小替代文档高度。
- 审批指纹包括正文、图片、封面、布局和HTML。更新目标在上传前和发出请求前都回读，比对上次确认的版本。保存后比较完整可见文字和图片来源/宽高；预览URL从最新回读提取。
- `handoff` 只在已完成回读后提供当前任务右侧面板参数。Host记录实际queued/opened结果，复用已知标签；无法观察页面时不把queued当可见成功。
- 每个 run 的变更命令由文件锁串行化，`status` 会显示当前动作、步骤和截止时间。并发 `resume`、修订、草稿写入或回读会被拒绝，不允许晚到任务覆盖较新的阶段状态。
- 标签身份绑定当前任务和草稿 media_id；跨任务不复用旧 tabId，必须在新任务中重新回读并观察标签。流程开发验收使用隔离接口与工具契约测试，不把实际生成草稿当成修复代码的必要步骤；用户不要求草稿时，不重建、不轮询旧草稿、不索要重建授权。
- 渲染器只生成HTML和payload，不接受直接草稿写入。旧 `wechat-loop.mts` 仅保留查询入口。局部修订复用未变的远程图片和封面；实际发布payload只允许相对已审渲染替换图片URL，其他变化拒绝。
- `--local-only` 只用于明确的本地审阅，不验证远端存在性；该属性传递给子修订并永久禁止草稿写入。回读失败会撤销交付URL并保留错误证据，不能用旧链接冒充当前草稿。

## 原有安全门禁

- 研究完成后，关键主张必须有 URL、抓取时间和摘录。任何影响核心结论、机制、关键数值/时间线或推荐的外部事实冲突，强制进入 `awaiting_human_fact_resolution`。
- 写作前由 outline Agent 审目录；事实冲突清零后依次经过结构编辑和语言编辑。两者必须实际输出完整 Markdown，不得新增无证据事实。
- 人工必须对每个重大冲突选择 `research_wins`、`retain_with_qualification` 或 `drop_claim`；存在未决冲突时，渲染、上传和草稿动作全部拒绝。
- 渲染后必须通过目录、章节数量、第一章长度、结语合并、抽象标题、正文引用编号、移动端字号、H2/H3、自然编号、代码卡片、内联样式、封面和 390px 截图检查。QA 单次返回视觉判定和首屏文字证据，必须读出首屏中的项目关键词；看不清图则直接阻断。目录是静态导航：微信草稿接口拒绝正文 `id`、`name` 和 `href="#…"` 锚点。
- 草稿前必须校验内部审批保护、QA、工作稿哈希、封面、无未决冲突和公众号预检。正文本地资产先转为 PNG、上传并写入 `publish/article.md` 的远程 URL，才会生成实际草稿 payload。
- 草稿创建/更新后必须 `draft/get` 回读标题、完整标题序列、正文引用编号、移动端字号、封面 media_id 和本地路径残留；接口未提供 URL 时，只交付真实 `media_id`。

## 草稿回读与恢复

- 创建草稿要求标题不超过 32 个字符（md2wechat 预检口径）。
- `approve-draft` 会在创建后回读 `draft/get`，校验标题、文章目录、首个 H2 和本地资产路径；微信实际把 `news_item` 放在响应顶层。
- `media_id` 在创建成功后立即落盘，回读失败不会丢号；用 `verify-draft <run-id>` 重跑回读校验即可把运行推进到 `completed`。
- 工作稿在 QA 后被改动时，`resume` 会自动重渲染并重新过 QA，再进入草稿审批。
- `state.json` 用临时文件加重命名保存；阶段表示下一项未完成工作。规划、写作、视觉、渲染和 QA 中断后，`resume` 重跑该阶段，不能跳过失败的写作或 QA。每次角色调用使用新的受限 thread，输入输出保留历史；QA 要求修正正文时进入 `targeted_revision`，仅返回当前稿的精确补丁，直到通过、遇到阻断问题或修订次数上限。
- 已批准的草稿动作在远程请求前失败，`resume` 会重新检查门禁并继续；更新目标沿用已落盘的显式 `media_id`。封面始终使用 `state.cover` 指定的真实文件，JPG/JPEG/PNG 直接上传，SVG 先转 PNG。
- 远程创建/更新请求前先落盘 `requestId` 和 `requestStartedAt`；成功返回后，先持久化独立 `publish/draft-result.json`、`resultRecordedAt` 和 `post_draft_qa` 阶段，再开始回读。若结果已落盘而状态被中断或回退，`resume` / `verify-draft --media-id <same-id>` 只恢复 `draft/get` 回读，不重复写入。
- 请求已发出但没有成功结果时，结果属于未知，`resume` 明确拒绝盲目重试。先在微信后台核对；若确认草稿已写入，用 `verify-draft <run-id> --media-id <confirmed-media-id>` 认领并回读。更新不允许换目标；若确认没有写入，重新创建 run 并重新审批，不手改请求标记。
