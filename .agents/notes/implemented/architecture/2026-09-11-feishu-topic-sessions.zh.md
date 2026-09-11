# Agent Note: 飞书话题 session —— 一话题一 session

Status: implemented

[English](2026-09-11-feishu-topic-sessions.md) | 中文

## Problem

一群一 session 把并行对话压在一起：一个群同时跑多个线程时它们交错进同一上下文，一个话题的历史泄漏进不相干的回答。产品形态是按话题划界的对话。在目标私有化部署上，事件的 `thread_id`（`omt_` 前缀的稳定身份）标记话题消息，话题群与私聊皆然——已实测确认。

## Decision

Session 身份派生自路由二元组：不带 `thread_id` 的消息保持既有 `feishu-<sha256(chatId)>` id，既有会话重启后原样恢复；话题内消息把会话与话题身份联合哈希进同一 id 形式（组合分隔符不会出现在任何 chat id 里，派生输入永不重叠）。队列、handle 缓存、存活 agent 收养与恢复全部以派生 Session id 为键——串行化跟随 session，同一群的两个话题安全交错，而同一 session 的消息保持有序。话题 session 的标题为 `Feishu chat <chatId> topic <threadId>`，操作员在 Web UI 里可区分。路由只读事件载荷——无 session 事件或模型可见输入变更，两个 SDK 的期望输出与快照测试均不变。

## Consequences

- 主消息流的 id 格式不变；话题 id 共享形式但材料不同——无碰撞、无迁移。
- 群聊提及门槛已覆盖话题根消息（未被提及的根消息到不了入口）；普通（非话题）群里话题回复的根消息不带 `thread_id`，根落在会话主 session 而回复落在话题 session——平台形状，记入包 README。
- 模型可见引导语不变：话题消息与主聊天消息同框，session 边界本身约束了上下文。

## Alternatives considered

把话题折叠回主 session 的设置开关被否决为旋钮漂移——话题就是产品形态。仅哈希话题身份被否决，改为对路由二元组做同一派生：一条规则、一个碰撞域。在提示词引导语中点名话题被推迟：无现实需要的模型可见变更，话题 session 本来就看不到其他话题的历史。
