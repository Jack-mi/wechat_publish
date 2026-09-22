# 文章生产端到端修复验收

本轮修复针对 harness-knowledge-moat 交付复盘，保留已有未提交改动，不用临时任务包装器作为正式交付。

2026-09-21 用户明确范围为“就把整个流程里的问题给 fix 就行，不用生成最后草稿”。本次交付是流程代码、操作规范和自动化回归，不再要求重建、更新或打开真实公众号草稿。发布与右栏交付的实现仍须验证，但通过隔离的接口和工具契约测试验收，不把测试成功表述成真实远端交付成功。

## 必须验证

- [x] 局部修订命令覆盖参考编号、图内字号、图片显示宽度、精确文本替换；不重新调用全文写作，范围外内容和资产哈希不变。
- [x] 风格目标明确记录并进入真实编辑和独立 QA；编辑以当前稿为唯一工作稿，事实基准单独核对，风格未通过不得声称交付该风格。
- [x] 每次正文修改保留不可覆盖版本；保留各角色输入、输出和失败记录，支持标准恢复及从旧版本重新修订。
- [x] QA 一次报告全部有证据的问题，区分阻断项与建议；文本修复只作用于当前稿，正常技术区别不按翻案文风阻断。
- [x] 参考来源默认编号、名称链接、可见完整 URL；真实渲染后模拟去除链接标签仍通过完整回读，删除编号或 URL 则拒绝。
- [x] 图片外部尺寸与内部字号分开控制；真实 390px 首屏、完整高度及连续分段截图，检查标题孤字、溢出和图文范围。
- [x] 草稿审批绑定正文、资产、布局和已审渲染指纹；故障注入证明更新前拒绝远程变化、保存后拒绝正文/参考区/图片/标题不一致，保留作者、来源和评论设置。
- [x] 交付 URL 只能来自最新成功回读；工具契约测试验证同任务同目标复用标签、跨任务丢弃旧标签、回读换 URL 后重置为 pending，queued 与 opened 分开记录，输出固定右侧面板参数。
- [x] 单元和故障注入测试、真实渲染集成、既有真实模型验收均通过；公众号和宿主打开动作使用测试替身，不生成最终草稿、不群发、不修改 Vault 原文。

## 证据

### 自动化验收

- `WECHAT_AGENT_INTEGRATION=1 pnpm --dir scripts/wechat test` 于 2026-09-21 通过，日志 `/tmp/wechat-fix-final-tests.log`。包含局部修订四种范围、越界参数拒绝、正文/SVG/封面/布局锁定、不可覆盖版本和旧版本恢复、各阶段故障恢复、QA 畸形输出拒绝、建议不触发重写、发布渲染与已审渲染的精确比对。
- 发布测试覆盖 mock/real 隔离、请求结果不明时不重发、远程人工编辑前后两次保护、未变封面和图片不重复上传、完整文字及图片回读、回读失败撤销旧链接、右侧面板工具参数与标签 ID 继承。上述公众号接口使用测试替身，不代表真实远端已通过。
- 真实 doocs/md + Chrome 集成检查 390×844 首屏、全文及重叠分段、实际孤字检测和文末内容、50%宽度为原来一半、图内缩字不改变画布和显示宽度。渲染器直接 `--draft` 被拒绝；旧 loop 仅允许查询，生产统一走 Harness。
- 严格 TypeScript 检查通过，检查文件为 `article-contract.mts`、`mobile-preview.mts`、`wechat-agent.mts`、`test-runtime.mts`；`git diff --check` 通过。未添加依赖，未提交或回退已有改动。
- 后续审计新增含 `?wx_fmt=png&from=app` 的图片URL真实渲染回归，先复现旧字符串匹配把合法 `&amp;` 转义误报为本地图片残留，再改为解析图片 `src` 后比较。完整集成套件和严格类型检查再次通过，日志 `/tmp/wechat-fix-query-url-test.log`。未放宽已审payload精确比对或远端正文检查。
- 最终流程验收日志 `/tmp/wechat-flow-final-acceptance.log`，命令仍为 `WECHAT_AGENT_INTEGRATION=1 pnpm --dir scripts/wechat test`。新增覆盖去掉 `<a>` 标签仍保留完整来源、缺编号或 URL 时拒绝回读、作者/来源/评论设置保持、同任务两次 URL 变化时复用标签、跨任务不继承标签、QA 缺具体证据时拒绝。全部通过，严格 TypeScript 与 `git diff --check` 同时通过。

### 真实模型与文章

- 局部修订 run `624ae208-3390-4870-9ee3-eb316ed89575`，命令 `revise 4a57f17c-a287-4f72-a193-34daf9dddaef --scope references --local-only --goal ...`。真实 QA 通过，最终 Markdown 和 SVG 与最后确认版本完全一致，五个 H2、一个 H3，图片50%显示宽度保留。
- 风格验收 run `69ce4a92-4a8f-4f5e-aaa4-85046720989c`，命令 `revise 4a57f17c-a287-4f72-a193-34daf9dddaef --scope style --style khazix --local-only --goal ...`。真实编辑和独立 QA 均通过，`stylePassed=true`；两份正文版本哈希不同，四项来源、SVG、五个 H2 和一个 H3 保留。QA 的图片偏小建议为非阻断，没有反向放大用户已缩小的图。
- 两个 run 的证据分别位于 `.runtime/runs/<run-id>/agents/`、`qa/final.json`、`render/mobile-metrics.json`、`render/article-mobile-*.png`。模型均为显式 `WECHAT_AGENT_MODEL=friday/gpt-5.6-terra`，不是 mock。
- 参考清理单元测试直接对无 `<a>` 标签的完整编号和 URL 文本验收；最终集成测试还对真实 renderer 产物做去标签和内容破坏检查。真实本地截图也检查参考区。本轮没有声称已验证微信服务当前的实际清理行为。
- 原图 PNG 与本次按正式 Chrome 参数生成的 PNG 均为780×1185，人工目检五个节点完整，无底部裁切；本次临时产物 `/tmp/wechat-fix-raster-current.png`。
- Vault 原文 `Agent-Harness/harness-knowledge-moat.md` 的 SHA256 仍为 `748070d33de0f95251c89dd1e8d2d0f6a3809fdd99ac39e28c72df7a97b7df74`。本轮没有远端写入或群发。

### 远端边界与历史记录

- 用户澄清前，2026-09-21 14:46–15:00 的检查发现草稿箱为空、旧目标返回 `invalid media_id`。证据为 `/tmp/wechat-fix-draft-inventory.json`、`/tmp/wechat-fix-final-blocker-check.log` 和旧 run 的 `publish/readback-failure.json`；当时已撤销旧交付 URL，没有静默重建。
- 按最新明确要求，真实草稿创建/更新、真实微信回读和 Codex 页面展示不属于本次交付，不再请求重建授权，不再以旧草稿失效阻塞流程修复。它们的实现通过隔离回归验证，未把测试替身当成真实远端成功。
- 今后用户明确要求产出草稿时，继续执行真实保存、回读和同任务右侧面板交付规则；本轮流程修复不改变这些生产门禁。
