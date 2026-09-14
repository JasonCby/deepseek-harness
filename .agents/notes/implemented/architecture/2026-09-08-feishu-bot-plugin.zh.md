# Agent Note: 飞书机器人 —— 会话即 Session，传输即热切换的设置边

Status: implemented

[English](2026-09-08-feishu-bot-plugin.md) | 中文

## Problem

harness 此前没有飞书（Lark）集成，而两个看似起点的现有接缝都不适合聊天机器人。`dsh-webhook` 的运行时是 fire-and-forget、每次投递新建一次性 Session——没有多轮延续、没有完成回调、也没有回到聊天侧的出站路径。`dsh-acp` 恰好具备正确的结算语义（提示词接纳、静默、助手文本收集），但它是 stdio JSON-RPC 服务器：经由它驱动飞书意味着多部署一个进程，其会话对 Web UI 不可见。聊天机器人还必须在飞书 3 秒事件确认窗口内应答，而 agent 轮次的运行远超这一窗口。

## Decision

一个插件 `@deepseek-ai/dsh-feishu`：传输无关的核心加两条互斥边。核心把每个聊天映射到确定性 Session id（`feishu-<sha256(chatId).slice(0,32)>`），重启恢复因此只是一次 `sessionPersistence.list()` 的成员检查——创建或 `agents.resume`，无需旁路映射。恢复时挂载会话头中持久的 `agentPreset`，保证重放历史仍可操作。结算在 `followup` 前记录 `session.seq`，`await agent.whenIdle()`，再从 `snapshotEvents()` 的该 seq 起提取 `assistant/message` 文本：持久日志是回复的事实来源。入口只做按 `message_id` 去重（飞书在得到确认前会重推）、允许清单/提及门槛和按会话排队——一切慢操作都在 3 秒确认之后。两条边分别是经 `@larksuiteoapi/node-sdk` 的外拨 WSS 长连接（无需公网地址；token 缓存、心跳、重连归 SDK 所有，且从不调用 `reConnect` 以规避上游定时器泄漏），以及鉴权留在 SDK dispatcher 内的入站 webhook 路由（challenge、AES 信封、签名）。`feishu` 设置命名空间（`installSection`）承载传输、凭据引用、允许清单与回复上限；`workspacePath`/`agentPreset`/`permissionPreset` 仅归组合所有，设置 UI 永远无法提升会话权限。提交的变更经 `EdgeController` 串行 stop/start 链热切换边；回复复用活动边的 API client，凭据变更将二者一并重建。图片与文件消息携带附件：入口从 content 文档读取 `image_key`/`file_key`，轮次经活动边的 API client（`im.v1.messageResource`）逐个下载并用 `attachments.saveFileStream` 保存，随后与框架文本一起每附件提交一个 `file` 块——LLM 运行时将其投影为只读宿主路径，任何 provider 都能消费；下载失败以失败提示收场该轮。出站交付由模型声明：每个聊天会话挂载 `feishu_deliver` 工具（agent setup 挂载，借用活 agent 时补挂），其校验过的调用参数留在会话日志；结算重放本轮的交付调用，文本回复之后每个声明文件经活动边（`im.v1.file.create`，`stream` 类型）上传为独立文件消息——单次失败只记日志，绝不让轮次失败。

一个不显然的机制：loader 条目处于 realm 隔离，插件上下文里 `ctx.get('webServer')` 解析不到任何东西。可选的 WebServer 因此经 `ctx.inject(['webServer'], …)` 维护一个引用；设置 `validate` 钩子与 webhook 边启动在引用为空时大声失败，引用到位后重跑先前被阻塞的 webhook 边。这一点由 REAL loader 组合测试发现——裸 `Context` 上的单元桩发现不了。

## Consequences

- 飞书事件重试在 `ConversationRouter.accept` 中、任何排队之前去重；按会话的队列还让会话创建与紧随竞态的第二条消息串行。
- `whenIdle()` 结算按仓库语义跟随替换工作；按会话的队列阻止后续飞书消息延长结算，但同一会话上并发的 Web UI 输入会被跟随到静默——接受并记录在包 README。Web UI 正打开的会话按原样借用（`agents.get` 先于 create/resume）：UI 的 resume 持有 JSONL 写声明，机器人对同一 id 再 resume 会以 `SessionAlreadyOwnedError` 失败。
- 包 README 记录的已知限制：回发为尽力而为（无发件箱）、传输切换或 WSS 断线期间事件丢失、每个飞书应用单实例（集群模式随机单播）、仅文本/图片/文件消息（图片以文件块抵达而非原生视觉）、附件下载在轮次内且不重试、恢复的会话使用部署默认模型路由、未加密 webhook 依赖路由保密。持久日志早于 session 格式 v3 的聊天在恢复时被拒绝（运行时的头版本检查抛错）并以失败提示作答；归档旧日志后同一聊天 id 可开启全新 v3 会话。

## Alternatives considered

复用 `dsh-webhook` 因契约不匹配被否决（一次性会话、无完成回调、无出站路径）。ACP 旁路进程作为第二个部署单元且会话对 Web UI 不可见被否决。自研 WSS 协议因长连接线路协议未文档化、SDK 已拥有 token 缓存与重连被否决。在 `agent-loop` 中新增专用完成事件钩子被否决，因为会话日志已携带结算所需的一切；为此新增 loop 扩展点只会违反"插件而非改 loop"规则而不带来新能力。
