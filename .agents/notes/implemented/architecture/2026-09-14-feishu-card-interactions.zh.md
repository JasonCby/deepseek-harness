# Agent Note: 飞书卡片交互——以回调应答审批与提问瀑布

Status: implemented

[English](2026-09-14-feishu-card-interactions.md) | 中文

## 问题

飞书通道此前能渲染结构化回复（markdown 卡片、绑定模板），但收不回任何东西：没有卡片携带交互组件、没有回调路径，且飞书驱动的会话上审批路径 fail-closed——不存在任何 `approval/request` 应答器。平台提供两种卡片回调投递方式，在控制台事件订阅旁选择：长连接投递（卡片动作以 `card.action.trigger` 事件帧走同一条 websocket）与请求地址投递（HTTP POST）。卡片实体更新 API（`im.v1.card.update`/`batchUpdate`）仅接受卡片 JSON 2.0，而本包发送的是 JSON 1.0。

## 决策

- **回调跟随控制台的投递配置，两个入口常备。** 长连接模式把 `card.action.trigger` 作为一条普通事件帧送达：websocket 边把它注册在 dispatcher 上，handler 的返回值由 SDK 中继为回调响应（SDK 的 `handleEventData` 会把 invoke 结果 base64 包装后回发）。请求地址模式 POST 到专用精确路由 `<path>/card`，经 SDK 的 `CardActionHandler`，与消息传输方式无关。两个入口共享同一分发步骤；未组合 WebServer 时仅服务长连接模式，跳过会记日志。
- **回调响应就地刷新卡片。** 回调响应携带 `{ card: { type: 'raw', data } }`（或 `template` 指令）时飞书更新被点击的卡片，条件是卡片结构版本一致——1.0 进、1.0 出。这完全替代仅支持 2.0 的更新 API；`dispatch` 为同步，响应远落在平台三秒窗口之内，agent 的后续回合异步继续。
- **认领优先级前置。** 宿主层的远端事件转发器在启动时注册，见到请求即认领、仅在其客户端放弃时才透传；按普通顺序注册的通道应答器永远轮不到，且无客户端连接时请求会永久挂起。因此应答器以 `prepend: true` 注册：有锚点的认领排在最前，无锚点的轮次照常透传给转发器。
- **应答器按 agent 挂载、只认领有锚点的轮次。** `InteractionBridge.mountAnswerers` 在每个聊天 agent 的作用域上下文（创建/恢复走 setup 回调、收养走 agent 自身 ctx）注册 `approval/request` 与 `user-questions/request` 监听器，作用域销毁即撤销认领路径。监听器查询 `ConversationRouter` 为该会话活轮次记录的锚点；无锚点即该轮属于其他通道，经 `next()` 透传，Web UI 继续应答自己的会话。卡片投递失败与功能禁用同样透传。
- **模板管外观框架，构建器管交互组件。** 可配的 `pendingCard`/`settledCard` 是本地卡片 JSON 1.0 框架，占位符为 `{{toolName}}`/`{{reason}}`（挂起）或 `{{outcome}}`/`{{decidedBy}}`/`{{summary}}`（结算）；构建器插值后追加按钮行（value 携带品牌化交互身份）或生成表单体——带选项的题目投影为 `select_static`/`multi_select_static`，无选项题目投影为 `form` 内的 `input`，提交按钮的 value 携带身份。结算样式也可改指平台 `settledTemplateId`。
- **回调先做线上校验再匹配。** `parseCardAction` 读取 SDK 处理器交付的扁平形态（header/event 合并后 `action`/`operator` 位于顶层），收敛出身份、裁决、表单值与操作者。未知或畸形的交互仍成功应答——返回已结算 toast 而非错误——平台因此绝不会重试没有任何挂起交互能匹配的点击。请求中止（其 signal）按 cancelled 结算；迟到点击随之收到 stale toast，因为不存在无回调的刷新路径。

## 被否决的备选

**只做一个入口。** 只做长连接模式会搁浅请求地址部署（以及想要独立回调 URL 的 webhook 传输部署）；只做 HTTP 路由会迫使本地长连接部署开公网监听。在同一个分发步骤后面接通两条路径，成本只是一次 dispatcher 注册。

**用卡片实体更新 API 做刷新。** 它们要求端到端卡片 JSON 2.0；为刷新一族卡片而把整条回复路径迁到 2.0 是依赖倒置。回调响应刷新覆盖了交互路径（每次刷新都紧跟一次点击），不需要任何更新 API。残余缺口——无点击即可刷新其请求已中止的卡片——作为已记录限制接受。

**应答桥接器能看到的所有审批。** 瀑布已按 agent 过滤作用域，但同一会话可能由 Web UI 驱动；认领这些请求会与 Web UI 自己的面板竞争。锚点（仅本路由正在服务的轮次才设置）把认领在结构上绑定到通道所有权，而非启发式。

## 结果

`ask_user_question` 从飞书可答（选项为下拉、自由文本为输入框；应答协议的 `custom` 槽位暂只承载无选项题的答案）。聊天会话上此前 fail-closed 的权限询问路径，在预设策略为 ask 时经确认卡解决。样式覆盖复用模板管线的方言规则（`resolveCardFormat`、builder-i18n 提升），`interpolateCard` 成为共享导出。测试覆盖构建器、线上校验、两条瀑布的认领/透传/中止路径、fake SDK 下两个入口（dispatcher 注册与路由 HTTP 纪律），以及一条经真实 `CardActionHandler` 的真实 Loader 组合往返。

## 相关决策

卡片回复与模板记录于[卡片回复 note](2026-09-10-feishu-card-replies.zh.md)与[模板 note](2026-09-11-feishu-card-templates.zh.md)。审批瀑布的契约在 `dsh-user-approval`；提问 schema 在 `dsh-user-questions`。须跨重启存续的长时审批在此刻意不在范围内——它需要持久挂起状态与 follow-up 续跑，规划为独立能力缝。
