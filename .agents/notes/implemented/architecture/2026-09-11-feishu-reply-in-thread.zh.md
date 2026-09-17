# Agent Note: 飞书 reply-in-thread —— 每问一个 bot 开启的话题

Status: implemented

[English](2026-09-11-feishu-reply-in-thread.md) | 中文

## Problem

仅有话题路由时，建话题留给用户手工完成，而企业形态恰恰相反：用户在主消息流提问，数智员工在该问题根系的话题内作答，追问延续该话题——一问一个有界 session，主消息流成为干净的索引。回复接口请求体的 `reply_in_thread` 标志恰好开启这种话题；已在 SaaS 私聊实测（确认 `chat_mode=p2p`；开话题回复返回 `thread_id`，不带标志的后续回复落进同一线程）。

## Decision

在 `replyInThread` 设置（默认关）下，`process()` 先开话题再跑轮次：`createTopicOpener`（新增 `topic.ts`）对获准的主消息流消息带 `reply_in_thread: true` 回复，引导内容为 `topicSummary(text)`——消息单行化并截断到固定 64 字符——且响应必须同时携带引导消息 id 与 `thread_id`，否则视为开启失败。轮次随后经合成的 `(chatId, threadId)` 消息路由进话题 session（PR-B 派生），结算回复与失败通知都以引导消息为目标、留在话题内。已在话题内的消息绝不再开新话题。开启被拒或失败时，轮次降级为主消息流就地回复（记日志）；边切换间隙的不可达 opener 占位同样降级，而回复占位保持大声失败。无 session 事件、模型可见输入或 loop 变更。

## Consequences

- 设置开启后，主消息流每个问题按构造落入自己的话题 session——主 session 停止累积，跨问题上下文污染消失，无需单独的生命周期策略。
- 话题的根是用户自己的消息；bot 的引导消息是线程内第一条（问题摘要），兼作「已转入话题」的可见提示。
- 依赖只有一项平台行为：话题式回复。已在 SaaS 私聊验证、普通群有官方文档；私有化部署若拒绝它，轮次就地降级而非丢失，记入包 README。

## Alternatives considered

先跑轮次再带答案开话题被否决：`thread_id` 只在开启调用之后才存在，session 身份将晚于轮次。按根消息 id 键控话题 session（OpenClaw 的技巧）被否决：要重键 PR-B 方案，且在 `thread_id` 这一规范身份之外依赖 `root_id`。主 session 生命周期的设置旋钮（持久 vs 每问）被否决为冗余——该设置按构造已蕴含每问。
