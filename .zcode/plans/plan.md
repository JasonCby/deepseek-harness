# 飞书数智员工：PR 系列正式计划（修订版 2）

## 已确认的决策记录

总目标：AI 原生数智员工基础能力包，飞书为 IM 通道，多租户，覆盖审批/督办/开放查询。

- 确认卡 = 工具审批确认（走 `approval/request` 瀑布）；集成 = 专用查询缝；长流程 = 独立 PR
- 长审批 = 持久审批 PR（会话事件 + 投影，不新建存储）；定时任务全部复用 dsh-schedule
- 过期驱动 = schedule 提醒 → 有界工具调用（工具校验只允许对投影中已过 expiresAt 的 flow 操作）
- 事件粒度 = 每级一个 `requested`（chain 首事件声明一次，审计流完整）
- 卡集 = 声明式注册缝：workflow/skill 包作为 Consumer 在 `ctx.cardSets` 注册卡集，feishu 实现"渲染 + 回调映射" Provider。卡集三类卡 = 通知（回合回复位渲染、工具结果注入）/ 动作（点击触发）/ 表单（填入 + 提交触发）；动作/表单卡必须本地 card JSON 1.0，平台模板只用于通知卡
- 出回合触发复用 PR3 的外部事件 → resume 桥；点击本身入会话日志（model-visible ⟺ logged）
- 存储演进 = 不先建库：人员/角色进 settings 层或飞书派生（open_id、群/部门），技能与组合配置进 cordis.yml，审计天然在会话日志；等第一个真正写业务数据的工具出现（如报警处置落库），随其 provider 一起接库——以真实表结构与访问模式为依据，不先建库等需求
- 数据库选型 = PostgreSQL：需要落库/向量检索时采用 PG（pgvector）；接入按数据类别走既有缝——业务数据随工具 provider 进（连接串走 credentials 引用），应用状态加 storage provider，会话日志如换后端走 session-persistence provider（事件格式不变，不 bump `SESSION_FORMAT_VERSION`）；流程/审批状态不另立业务表（守住"事件+投影，不新建存储"）

---

## 数智员工最终形态（目标画像）

普通用户视角：

- 它是飞书里的一位"同事"：可以私聊，也可以拉进群里 @ 它派活。
- 一句话交代任务后，它自己完成整个过程——查系统、读文件、调 API、跑多步流程。
- 需要人拍板的时刻，它发一张卡片：点"批准/拒绝"，或在表单里填几个字段提交，指令立即生效（放行工具、落库、调用飞书 API、推进流程）。
- 过程与结果都落在结构化卡片上：查询结果、告警摘要、流程进度——轮到谁、卡在哪、何时过期，一目了然。
- 长流程不用有人守着：审批逐级推进，轮到谁谁的飞书里出现卡片；临近超时它主动提醒，逾期它按规则督办。
- 每个团队/租户带自己的配置与流程模板，导入即用。

技术形态一句话：飞书是通道，dsh agent 是大脑，卡片是它的"手"。模型保留"何时发起、决议后做什么"两个自由度，卡片把"需要人拍板的时刻"压缩成一次点击；人的每次点击都进会话日志，可审计、可回放。

---

## PR1 — feishu 短交互闭环 ✅ 已实现（待合入）

分支 `feishu/card-interactions`，秒到分钟级交互已交付：`lark.ts` 双通道回调入口（长连接 `card.action.trigger` + HTTP `CardActionHandler`）、`edges.ts` 双通道注册与 `<path>/card` 路由、`interaction.ts` 桥（瀑布认领/委托/中止、pending 表、回调即原地刷新）、`interaction-card.ts` 构建器、`config.ts` `interactionCards` 段、四组 spec（unit/edges/loader-composition/router）、README×3 + Agent Note。设计细节以 [Agent Note](../../.agents/notes/implemented/architecture/2026-09-14-feishu-card-interactions.md) 为准。

后续复用关系：PR3 的回调入口与 PR4 的卡集构建器都从这批模块泛化，不在本 PR 扩展。

## PR2 — integration/alarm-query 专用查询缝（可随时开工，与 PR1 合入无依赖）

分支 `integration/alarm-query`，新组 `packages/integration/`：

- `integration-alarm`（Definition，`ctx.alarmQuery`）：`registerAlarmProvider`、`resolve(request): AlarmQuerySpec` 显式默认、provider 选择梯、`AlarmError extends HarnessError` 封闭码。
- `integration-alarm-http`（Provider）：Config（baseUrl/credentials 引用/timeoutMs/重试），vendor JSON→封闭对象映射。
- `tool-integration-alarm`（Consumer）：`alarm_query` 工具，output `{schema, render, presentationMeta}` 固定报警结构（meta 超限整体省略）。
- 飞书零改动（`bindTool: 'alarm_query'` + meta 路径即出卡）；apps/cli 示例 cordis.yml 加样例。capability-seams 表更新。
- 本 PR 的报警卡随后作为 PR4 卡集的第一个真实 Consumer 收编。

## PR3 — 持久审批（长审批核心，依赖 PR1）

新组 `packages/approval/`：

**事件（自包含，发起时快照解析结果，折叠永不回读配置）**

- `approval-flow/requested`：`{ id: ApprovalFlowId, title, businessKey?, summary?, chain: ApprovalLevelSpec[], levelIndex, createdAt }`，`ApprovalLevelSpec = { name, approvers: string[](非空), timeoutMinutes? }`
- `approval-flow/decided`：`{ id, levelIndex, outcome: 'approved'|'rejected'|'expired'|'cancelled', decidedBy?, at }`
- 声明合并进 SessionEventMap，带 `ignorable` 信封；不 bump `SESSION_FORMAT_VERSION`。

**投影（照 `schedule/projection.ts` 契约）** `ProjectionDefinition`：`key: 'approvalFlow'`；`stateSchema` zod strict + superRefine 不变量（active id 唯一、levelIndex 单调）；`init(header, inheritedEventCount)`；`apply` 纯函数、`seq < inheritedEventCount` 忽略、与 append 路径共享严格解码器（非法即抛，fail loud）；`wire` 暴露 `approvalFlow: readonly PendingApproval[]`；`stateVersion: 1`。**时间不入折叠**：过期是读取侧派生判断。

**服务与工具**

- `ctx.approvalFlow`：`request(resolve(request): Spec)` —— append requested（转换校验）+ Provider 发卡 + 按级建 schedule 提醒；`resolve(id, levelIndex, outcome)` —— append decided，approved 且有下级则追加下一级 requested + 发卡，终态则 followup 续跑。副作用只在 append 时刻，绝不在 fold。
- `tool-approval-flow`：`request_approval` 工具，**立即返回**（不挂回合）；过期工具由提醒消息驱动，校验只允许对投影中已过期 flow 操作。
- feishu 实现 Provider：发卡 + 把 PR1 回调映射成 `resolve()`；卡片 action value 携带 `{flowId, sessionId}`（回调随时可能到达，不依赖活路由）。
- 回调门禁：`resolve()` 校验操作者 ∈ 本级 approvers（open_id 比对），无权点击响亮拒绝（toast 报错，不静默）；同 PR 决定回合内审批卡（PR1 `interactionCards`）是否引入允许决策人列表，消除"能看到卡即可点"的缺口。
- 多级推进在服务端状态机，模型只有"何时发起"与"决议后做什么"两个自由度。

**回调入口与 followup 桥按可泛化缝设计（PR4 的前置，本 PR 不加价）**：action value 携带 `{kind, ids…, sessionId}` 封闭联合，dispatch 按 kind 路由；approval-flow 是首个 kind，不是唯一硬编码路径。开工首查的 delayed update 结论对 PR4 卡集共用。

**开工首查（实现期验证项）**：compaction 对 `schedule/change` 在压缩后缀的处理方式（approval-flow 必须镜像，否则压缩丢 pending）；idle agent 续跑送达路径与 jobs 唤醒不冲突；飞书卡片回调时效性/delayed update token 对照官方文档。

## PR4 — cards 卡集缝：workflow/skill 声明式卡片集（依赖 PR3 的桥）

新组 `packages/cards/`。目标：每个 workflow/skill 声明自己的一组卡片，三类——通知（工具结果填入某卡片展示）、动作（点击触发特定工具/技能）、表单（内容填入 + 提交触发，如落库/调用飞书 API/发送给某人）。

- `dsh-card-sets`（Definition）：`ctx.cardSets.register(spec)` 注册即效应；`resolve(request): Spec` 显式解析；卡集/卡/动作 id 品牌化（照 `WorkflowRunId` 工厂）；卡片 kind 封闭联合 `notify | action | form` + `assertNever`；动作目标 = 工具名 + 参数模板（从 `form_value` 组装）。
- 三类卡形态：
  - `notify`：回合回复位渲染（接现有 reply 管线），变量沿用 `TemplateVariableRule`（tool-result 路径 / context 键）；平台 `templateId` 或本地 JSON 1.0 均可。mid-flow 主动推送归 PR5。
  - `action`：按钮 value 携带 `{kind: 'card-set', cardSetId, cardId, actionId, sessionId}`；必须本地 JSON 1.0（平台模板承载不了携带身份的按钮值）。
  - `form`：内容注入 + `form`/`form_submit` 组件（从 PR1 `interaction-card` 构建器泛化）；提交后参数模板从 `form_value` 组装。
- feishu Provider：`parseCardAction` 扩展 admitting 卡集身份；回调 → `card-set/action-received` 会话事件（声明合并进 SessionEventMap，评估 `ignorable` 信封，不 bump `SESSION_FORMAT_VERSION`）→ followup 回合调用目标工具/技能；触发的工具照常走权限/审批瀑布（PR1 的卡可应答，形成组合）。3 秒窗口内回调只回"已受理"式原地刷新，工具执行异步。
- 可替换性：租户侧按卡集名覆盖样式/模板（feishu Config 的 override 段），在 `resolve(request): Spec` 步骤与声明默认显式合成——换通知模板不动 workflow 包；动作/表单卡的交互组件仍必须本地 JSON 1.0，不可覆盖为平台模板。
- Consumer：至少一个真实消费者（PR2 的 alarm-query 注册自己的报警卡集）+ apps/cli 示例。
- 已知限制照记：工具完成后的二次刷新受卡片实体更新 API 仅支持 JSON 2.0 的限制（沿用 PR1 立场，PR3 首查结论共用）；卡集绑定呈现的工具名，skill 以其调用的工具呈现。
- 测试：seam 三角色、回调 wire 校验、followup 触发、keyless 快照；README×3 + Agent Note。

## PR5 — 长查询 jobs 化 + 主动触达/督办（依赖 PR1、PR3 的桥；复用 PR4 卡集）

- 长查询走 jobs 化；主动触达解锁 mid-flow 通知卡与督办卡——直接复用 PR4 卡集的 `notify`/`action` 形态，不另起卡片机制。

## PR6 — 多租户配置化 + 流程导入

- 如届时已引入 PG 业务库：租户隔离用 PG schema/RLS 表达，不自建隔离层。

---

## 通用交付纪律（每 PR 验收）

缝三角色完整分包；注册即效应；品牌化 id（照 `WorkflowRunId` 工厂）；封闭联合 + `assertNever`；durable 边界全验（事件 JSON、转换校验、zod stateSchema），typed 边界信任 TS；可调项全走 Config；错配响亮；不改 agent-loop；model-visible ⟺ logged；Agent Note + 双语 README + i18n 配对；typecheck/lint/constraints + 受影响包单测；推送前 dsh-pre-push-checks；作者 octmoon。

## 执行顺序

PR1 已实现待合入；PR2 随时可开工；PR3 待 PR1 合入后开工（先完成三个首查项）；PR4 卡集紧随 PR3 的桥落地开工；PR5 依赖 PR3 的外部事件 → resume 桥并复用 PR4 卡集；PR6 待配置面定型。
