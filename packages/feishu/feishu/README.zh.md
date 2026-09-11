---
description: "飞书（Lark）机器人插件：经长连接或 webhook 路由接收聊天事件，驱动多轮 DSH 会话并回发回复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu

[English](README.md) | 中文

## 概述

`dsh-feishu` 把飞书机器人变成 DSH 的前置入口。每个飞书会话映射到一个多轮根 Session；每条获准的消息成为一轮普通 follow-up；轮次完成后会话日志中的助手文本经飞书 API 以纯文本或单张 markdown 卡片回发。两条互斥传输边承载事件——无需公网地址的外拨 WSS 长连接，以及挂在可选组合的 `dsh-host-webserver` 上的入站 webhook 路由——`feishu` 设置段变更时活动边热切换。

## 目录

- [配置](#configuration)
- [传输](#transports)
- [服务 API](#service-api)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="configuration"></a>
## 配置

| 键 | 含义 |
|---|---|
| `transport` | `websocket`（默认）或 `webhook`。 |
| `domain` | `feishu`（默认）、`lark`，或私有化部署的完整 API 地址（`https://…`）。 |
| `appIdEnv` / `appSecretEnv` | 每次边启动时解析的凭据引用；设置字面量 `appId`/`appSecret` 时优先生效。 |
| `verificationTokenEnv` / `encryptKeyEnv` | 仅 webhook 使用的凭据引用（SDK dispatcher 校验）。 |
| `path` / `maxBodyBytes` | webhook 路由路径（默认 `/feishu`）与请求体上限（默认 65536）。 |
| `allowChatIds` | 机器人应答的会话；为空（默认）时应答到达机器人的每个会话。 |
| `groupRequireMention` | 群聊中仅应答被提及的消息（默认 `true`）。 |
| `replyForm` / `cardTitle` | 回复形式：`auto`（默认；携带工作流或审批的轮次回单张 markdown 卡片，其余回文本）、`text`、或 `card`（始终单张 markdown 卡片）；`cardTitle` 为卡片头标题（默认 `DSH`）。 |
| `thinkingEmoji` | 作为思考指示器括起每条获准消息的表情 key（默认 `Typing`）；留空禁用指示器。 |
| `replyCharLimit` / `failureNotice` | 回复截断上限（默认 4000，两种形式共用）与失败回复文案。 |
| `dedupCapacity` | 重试去重所记住的消息标识数（默认 1024）。 |
| `workspacePath` / `agentPreset` / `permissionPreset` | 仅部署层：会话的工作区、agent 组合与沙箱/审批预设。绝不可经设置修改。 |

除最后一行外的全部字段构成 `feishu` 设置命名空间（`installSection`），设置 UI 可实时编辑，提交即热切换传输边。

<a id="transports"></a>
## 传输

- **websocket** —— SDK 客户端（`@larksuiteoapi/node-sdk`）外拨建连，因此无需公网地址、TLS 终结或 challenge 握手。飞书对每个应用凭据要求单连接语义；每个应用运行一个 DSH 实例。
- **webhook** —— 在所组合的 WebServer 上注册一条精确路由（经可选的 `ctx.inject` 引用解析；没有 WebServer 的 webhook 段会被设置 `validate` 钩子与边启动同样大声地拒绝）。将 TLS 反向代理指向隔离监听器，参见 [overlay 示例](../../../apps/cli/config/examples/feishu-bot/cordis.yml)。

<a id="service-api"></a>
## 服务 API

- `sessionIdForChat(chatId)` — 确定性的 `feishu-<sha256(chatId)>` Session id；重启后以同一 id 恢复持久化会话，无需旁路映射存储。
- `ConversationRouter` — 按消息 id 去重、按会话排队、会话创建/恢复（其他通道为会话发布的存活 agent——如 Web UI——直接收养而非重复恢复）、从会话日志结算轮次，并以尽力而为的思考表情括起每条获准消息。
- `EdgeController` — 串行化边生命周期；`reconfigure()` 停掉活动边并按当前设置启动新边。
- `larkSdk` — 收窄的 SDK 表面（`createApiClient`、`createWsClient`、`createDispatcher`、`generateChallenge`），测试可注入。
- `renderMarkdownCard` — `card` 回复形式所用的纯投影：结算文本 → 卡片 JSON 1.0（固定蓝色头部承载 `cardTitle` + 单个 markdown 元素）。

每条获准的聊天消息追加为一条 `user/message`，source 为 `{ kind: 'feishu', chatId, messageId, form: 'notice', summary }`（声明合并进 `MessageSourceMap`）。

## Model Experience

### 飞书聊天提示词

#### 模型可见内容

每条获准消息对应一条 `user/message`。提示词文本为一行固定引导语——`Feishu chat message (untrusted external input; chat {chatId}, sender {senderOpenId}):`，其中 `{chatId}` 与 `{senderOpenId}` 为插值（事件未携带发送者 id 时为 `unknown`）——后接空行与发送者撰写的消息文本，后者不具任何信任级别，也无自身长度上限。

#### Token 效应

数据依赖：每条获准消息产生一个提示词。重试在提示词存在前已去重，允许清单或提及门槛丢弃的消息零 token。

#### KV Cache 效应

只增不改：每条获准消息追加到对话。设置变更永不重写历史；传输热切换只触及边，不动会话日志。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **回发为尽力而为** — 轮次结算与飞书 API 调用之间进程崩溃会丢失该回复；没有重试队列或持久化发件箱。
- **传输切换窗口内事件丢失** — WSS 长连接无补推，webhook 路由在切换窗口（秒级）内注销。
- **每个飞书应用单实例** — 飞书集群模式将事件随机单播到一条连接，同一应用凭据跑两个 DSH 进程会随机丢事件。
- **入站仅文本消息** — 非文本聊天类型与消息卡片在入口归一化处丢弃；出站回复按所配 `replyForm` 取文本或卡片。
- **飞书 markdown 为子集** — 卡片回复按飞书 markdown 方言渲染；GFM 表格等不支持的语法在卡片中降级。
- **恢复的会话使用部署默认模型路由** — 从 Web UI 切换的模型不随进程重启在会话中保留。
- **未加密的 webhook 无签名校验** — encrypt key 为空时 SDK dispatcher 接受未签名请求体；此类部署依赖路由保密（隔离监听器模式见 GitHub webhook 指南）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

传输无关的核心刻意绕过 `dsh-webhook` 运行时：聊天延续、完成结算与出站回复路径都不符合其一次性 fire-and-forget 契约。可选 WebServer 必须经 `ctx.inject` 消费，因为 loader 条目处于 realm 隔离；插件上下文里的动态 `ctx.get` 解析不到任何东西。设计依据与被否决的备选见 [Agent Note](../../../.agents/notes/implemented/architecture/2026-09-08-feishu-bot-plugin.zh.md)。卡片回复记录于[其专属 Note](../../../.agents/notes/implemented/architecture/2026-09-10-feishu-card-replies.zh.md)；按轮自动路由回复形式记录于[auto-form Note](../../../.agents/notes/implemented/architecture/2026-09-10-feishu-auto-reply-form.zh.md)；跨通道存活 agent 收养记录于[收养 Note](../../../.agents/notes/implemented/architecture/2026-09-11-feishu-live-agent-adoption.zh.md)；思考表情记录于[其专属 Note](../../../.agents/notes/implemented/architecture/2026-09-11-feishu-thinking-reaction.zh.md)。

</details>
