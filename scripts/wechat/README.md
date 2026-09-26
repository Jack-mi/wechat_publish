# 公众号技术文章模板

这个目录保存可版本管理的公众号发布资产，不会改写 Vault 里的原始文章。渲染器是固定在 `vendor/doocs-md/` 的 [doocs/md](https://github.com/doocs/md) Git submodule；依赖目录不提交，克隆后按下方说明安装即可复现。

模板是 `tech-deep-dive`：作者撰写的一段通俗项目介绍直接开篇，并自然带出文章话题；不标注“项目引子”或“项目因子”，也不用字段清单、引用块或目录。正文包含两级标题和结尾 CTA，不再渲染“全文导航”副标题或重复的文章标题行；公众号自身标题保留在草稿字段，正文不重复展示。微信 `draft/add` 会拒绝正文内 `id` / `name` / `href="#…"` 锚点；渲染器会拒绝输出这类会导致草稿创建失败的标记。模板统一输出自然数编号：一级章节为 `1.`、`2.`…，二级小节为 `1.1`、`1.2`…；源文档中手写的任意旧序号会被替换。所有文章都禁止使用 `01`、`02`、`03`、`01.1` 等补零编号，也禁止在文章中展示“解读版本”或“季度版本”元信息。正文一级章节是深色章节条，二级小节是浅蓝标签式标题；任何 fenced code 都会以深色、圆角、带代码块头部的独立代码卡片输出。它用 doocs/md 渲染正文，再用已安装的 `juice` 将 CSS 内联；这是避免公众号编辑器丢弃 `<style>` 后退化为纯文本排版的必要步骤。

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

渲染器不允许直接创建草稿。草稿写入统一使用下方 Harness 命令，经过审批、QA、远程更新保护和完整回读。

## Codex SDK Agentic Loop

修复本流程或其工具不等于要求生成文章草稿。流程开发默认通过本地回归、真实渲染和模拟公众号接口验收；用户明确“不用生成草稿”时，不读取或写入真实草稿，也不因旧草稿失效反复索要重建授权。真实草稿交付仅在用户明确要求产出文章草稿时进行。

`wechat-agent` 是公众号生产 Harness：主 Agent 编排目录、写作、结构编辑、语言编辑、视觉和 QA 的受限 Codex SDK thread；正文始终由本目录的确定性 doocs/md 脚本渲染。`wechat-loop` 继续保留为旧流程兼容入口。首次使用安装其最小依赖：

```sh
pnpm --dir scripts/wechat install --frozen-lockfile
```

启动仅生成审阅包，不会上传或创建草稿：

```sh
pnpm --dir scripts/wechat wechat-agent improve <article.md> --vault /absolute/path/to/vault --goal "完善文章" --cover /absolute/path/to/cover.jpg
```

输出中的 `runId` 对应本工程 `.runtime/runs/<runId>/`：其中包含目录审稿、文章快照、结构编辑、语言润色、HTML、移动端首屏与全文长图、QA、状态和事件。Vault 只通过 `--vault` 作为显式内容源，不保存运行产物。通过后停在 `awaiting_draft_approval`。以下命令批准并开始创建草稿：

```sh
pnpm --dir scripts/wechat wechat-agent approve-draft <runId>
```

使用 `status` / `report` 查看状态，使用 `resume` 继续同一个 Agent run，包括恢复已批准但尚未发出远程请求的草稿动作。动作与更新目标由 CLI 落盘，使用者无需取得或输入 token。草稿接口没有返回 URL 时，以真实 `media_id` 交付；Harness 不会伪造草稿链接。

封面生成兼容本地 `data.output_file` 与远程 `data.original_url`，成功的生成响应会保存，下载失败后的 `resume` 不会重复生成。替换已审稿或阻断稿的封面使用 `revise <run-id> --scope image --cover /absolute/project/path/cover.png`，正文、图表和布局保持不变，重新渲染并独立 QA 后才能创建草稿。

完整状态、权限和质量门禁见 [`PROTOCOL.md`](./PROTOCOL.md)。

草稿创建后若回读校验中断，用 `pnpm --dir scripts/wechat wechat-agent verify-draft <runId>` 重跑回读校验。群发不属于这条流水线，脚本没有调用对应接口。

若远程请求已经开始但响应丢失，不自动重试创建或更新。先核对微信后台，确认写入后用 `verify-draft <runId> --media-id <confirmed-media-id>` 恢复；更新仍必须匹配原目标。封面支持 JPG/JPEG/PNG 和 SVG，SVG 上传前转换为 PNG。

`WECHAT_AGENT_MOCK=1` 只用于模拟：模式创建时写入 run，后续不能切换为真实执行。旧 run 没有模式字段时仅保留查看能力和已有真实草稿的 `verify-draft`；要继续生产，请新建 run，勿直接批准旧 mock 测试稿。

## 局部修订

所有新稿正文直接从一段作者撰写的自然项目介绍开始，不标注“项目引子”或“项目因子”，不渲染文章目录，也不添加英文标语和重复标题卡；公众号自身标题及独立封面保留。旧草稿使用 `revise <runId> --scope layout --remove-title-card` 删去旧模板的标题卡，用 `--remove-toc-filler` 删去整个旧目录模块；两者都只允许移除对应旧模板行，正文及其他可见文字仍须逐字保留并通过 QA。旧稿迁移后还需用 content 修订把开头改成自然项目介绍，并在第一章补上必要的项目背景，才能通过当前模板验收。

```sh
pnpm --dir scripts/wechat wechat-agent revise <runId> --scope references
pnpm --dir scripts/wechat wechat-agent revise <runId> --scope image --font-scale 0.75
pnpm --dir scripts/wechat wechat-agent revise <runId> --scope layout --image-width 50
pnpm --dir scripts/wechat wechat-agent revise <runId> --scope content --patch /absolute/patch.json
pnpm --dir scripts/wechat wechat-agent revise <runId> --scope content --patch /absolute/patch.json --assets /absolute/assets.json
pnpm --dir scripts/wechat wechat-agent revise <runId> --scope style --style khazix --goal "自然对话节奏，保留事实边界"
```

references、image、layout、content 修订不调用 writer、outline 或全文编辑，只做确定性修改、渲染和独立 QA。补丁 JSON 为 `[{"before":"唯一原句","after":"替换句"}]`，重复或缺失目标会拒绝。图片外部宽度和图内字体分别控制。参考区统一“自然序号＋名称链接＋下一行完整 URL”，不生成正文脚注。

多张语义插图通过 content 修订导入。在补丁中把图片放到解释相应问题的段落旁，引用 `../assets/cost-comparison.svg`；assets JSON 为 `{"cost-comparison.svg":"/absolute/project/.runtime/editorial-inputs/cost-comparison.svg"}`。源文件必须在项目内，文件名只用字母、数字、连字符或下划线，支持 SVG、PNG、JPEG、WebP；SVG 不得包含脚本或外部资源。CLI 复制每张图片、锁定全部图片哈希、重新渲染审校，发布时逐张上传并验证回读。封面仍单独保留。图内数字注明实测或教学示例，并检查实际390px画面。

视觉阶段不再自动向文末添加通用流程图。内置绘图仅支持正文已明确引用的顺序机制图；数据对比等定制多图仍需上面的显式资产导入，不宣称自动生成。

每次修改创建子 run，保留父稿及不可覆盖的 `versions`。`revise ... --version N` 从指定版本开始。角色输入、输出和失败存入历史。`retry` 显式重跑失败的审查阶段，不重置次数、不手改状态、不重发未知结果的远程请求。

仅需本地预览或远程草稿已不可访问时，可显式 `revise ... --local-only`。它不读取远端，不表示草稿仍然存在；该 run 及其子修订永久禁止远程创建和更新，不能用来绕过更新目标检查。草稿回读失败立即撤销旧交付链接，不把历史成功状态继续当作当前成功。

新稿使用 `--style neutral|conversational|khazix` 记录目标，独立 QA 未通过不得宣称已交付该文风。旧稿未记录风格时，局部修订使用 `preserve` 表示保留原样，不冒充已验证命名风格。编辑的唯一输入稿是当前版本，事实账本仅用于核对。

已绑定草稿的子 run 必须 `update-draft <newRunId> --media-id <sameId>`。写前查远程变更，写后比对全文与图片。`handoff <newRunId>` 输出最新验证 URL 对应的 Codex 右侧面板工具参数，由 Host Agent 调用 `open_in_codex` 并复用同任务同目标的已知/观察到的标签 ID；跨任务必须重新回读，不继承旧任务标签。`handoff <newRunId> --status queued --tab-id <id>` 保存真实结果；仅在可见确认后记 opened。CLI 不会用外部浏览器替代交接。

## 模型与网络说明

- 所有子 Agent 都以严格结构化输出（json_schema）返回产物。`WECHAT_AGENT_MODEL` 可覆盖模型，未设置时继承本机 Codex 配置；所选模型必须支持严格结构化输出，QA 的判定字段还会在本地校验。 代码与文档不绑定具体厂商模型；封面生成模型默认 `doubao-seedream-5-0-lite-260128`，可用 `WECHAT_COVER_MODEL` 覆盖。
- QA 必须具备真实看图能力。单次 QA 同时给出视觉判定和首屏证据，必须报告首屏最上方文字及自然开场中读到的项目关键词；读不出图则直接 blocked 并提示更换 `WECHAT_AGENT_MODEL`，不会继续做假定的视觉验收。
- 全篇 QA 的附件为首屏、按顺序的重叠分段截图和封面；390×6000+ 的全文长图已由分段覆盖，不再发给模型。只改开场且正文、结构、图片和封面均锁定时，只采集首屏和封面，仍会保留全局确定性检查；纯参考来源或固定模板行删除不调用模型。发给模型的图片路径必须是绝对路径。
- Agent 调用都有硬超时：开场专项 QA 默认 90s（`WECHAT_SCOPED_QA_TIMEOUT_MS`），全篇 QA 默认 240s（`WECHAT_QA_TIMEOUT_MS`），其他 Agent 默认 600s（`WECHAT_AGENT_TIMEOUT_MS`）；超时即中止并报错，不再无限等待。QA 被禁止用 OCR、tesseract、Vision、像素分析等替代手段；读不了图必须 blocked。
- 同一 run 的变更命令由运行锁串行化，`status` 显示正在运行的动作、步骤与截止时间。远程草稿成功后先持久化结果再回读；若回读前状态中断或回退，`verify-draft --media-id <same-id>` 只做读回恢复，不会再次写草稿。
- 写作 Agent 需要核验公开网页事实，因此在 `workspace-write` 沙箱并开启网络下运行；该模式不挂载 Vault，正文、运行状态与资产仍只写入本工程 `.runtime/runs/<run-id>/`。
- `pnpm --dir scripts/wechat test` 覆盖确定性 QA、事实冲突门禁、结构化输出 schema、草稿回读解析、mock/真实模式隔离、各封面格式、截图输入、阶段中断与修订恢复、更新目标和防重复草稿写入。运行回归测试替换模型、命令与网络边界，不访问真实模型或公众号；临时测试 run 自动清理。
- `WECHAT_AGENT_INTEGRATION=1 pnpm --dir scripts/wechat test` 额外调用真实 doocs/md 渲染器与本机 Google Chrome，检查 390×844 截图及发布资产替换；模型、封面生成和公众号接口仍被测试替身隔离，不产生远程草稿。
