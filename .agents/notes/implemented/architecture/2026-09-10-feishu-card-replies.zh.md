# Agent Note: 飞书卡片回复 —— 结算文本即一张 markdown 卡片

Status: implemented

[English](2026-09-10-feishu-card-replies.md) | 中文

## Problem

机器人的出站形式只有纯文本（`msg_type: 'text'`，4000 字符截断），结算轮次的 markdown 结构在聊天气泡里被压平。督办与审批场景需要可读性好的输出，而飞书 reply API 原生接受交互卡片——受限的是本包自己收窄的 sender，不是平台。

## Decision

卡片回复是已落日志状态的纯投影。`renderMarkdownCard`（新增 `card.ts`）把结算文本——同一份 `extractReplyText` 输出、共用同一 `replyCharLimit`——包进一张卡片 JSON 1.0 卡片：固定蓝色头部承载所配 `cardTitle`，加单个 markdown 元素。`ReplySender` 携带经 `assertNever` 穷尽切换的闭合 `ReplyContent` 联合（`text` | `card`）；会话路由持有以 `replyForm` 设置为键的显式 `payload()` 解析步骤，失败提示跟随同一形式。`LarkSdk` 的 reply 表面放宽为 `msg_type: 'text' | 'interactive'`，与官方 reply API 的卡片支持一致。不涉及任何 session 事件、模型可见输入或 loop 变更——卡片派生自持久日志——因此两个 SDK 的期望输出不变，且 keyless 快照测试（只投影已发布 profile）没有 feishu 用例，与插件落地先例一致。

## Consequences

- `replyForm`（默认 `text`）与 `cardTitle`（默认 `DSH`）是设置段字段：热生效、校验非空，暂不进设置 UI 卡片（与 `appIdEnv` 同一子集先例）。
- 飞书 markdown 是 GFM 子集（表格不支持）；卡片形式对不支持语法降级渲染——记入包 README 已知限制。
- 卡片更新/patch（进度刷新）刻意不在范围内：它需要轮中事件消费与已发卡片 message-id 登记表——正是尽力而为投递限制已经标记的 outbox 形态状态。`ReplyContent` 判别联合是预留的扩展点。

## Alternatives considered

卡片 JSON 2.0 被推迟：只有 CardKit 流式更新强制要求它，机器人使用的 im reply/patch 消息接口支持 1.0。在文本 sender 旁另设 `sendCard` 函数被否决，改为单一载荷联合——一条线路、一个将来可扩展的判别键。文本与卡片各设截断上限被否决（旋钮漂移）；一个上限覆盖两种形式。
