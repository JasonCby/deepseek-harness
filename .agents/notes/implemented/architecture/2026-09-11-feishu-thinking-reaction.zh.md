# Agent Note: 飞书思考表情 —— 一个 Typing 表情括起每轮

Status: implemented

[English](2026-09-11-feishu-thinking-reaction.md) | 中文

## Problem

一轮聊天要运行数秒到数分钟而没有任何可见活动：发送者无法区分思考与沉默。飞书不向机器人提供「正在输入」指示器，但消息表情回应对机器人开放。

## Decision

一个尽力而为的表情括起每条获准消息：`process()` 在轮次开始前把所配表情（`thinkingEmoji`，默认 `Typing`——敲键盘小黄脸，已实测：增删均 code 0、应用现有权限即够）打到入站消息上，并在回复或失败通知之后于 `finally` 中移除。表情失败只记日志——指示器绝不让轮次失败——因此边切换间隙使用静默占位 sender，与大声拒绝的回复占位不同。`createReactionSender`（新增 `reaction.ts`）与回复 sender 同乘该边的 API client，在 `EdgeController.activate` 接线；收窄的 `LarkApiClient` 表面增加 `im.v1.messageReaction` create/delete。无 session 事件、模型可见输入或 loop 变更——指示器派生自轮次生命周期——因此两个 SDK 的期望输出与快照测试均不变。

## Consequences

- 指示器恰好覆盖获准的轮次：获准前的排队等待不显示任何东西，因为消息尚未被接受。
- 飞书限制只能删除应用自己添加的表情；移除调用携带添加调用返回的标识，响应缺少标识时表情留在原地。
- 空 `thinkingEmoji` 关闭指示器；表情集缺少 `Typing` 的部署经设置段换成自己的 key。loader-composition 夹具关闭它，使组合测试不发表情 API 调用。

## Alternatives considered

流式「思考中…」卡片在结算时替换被推迟到进度卡阶段：它需要 im 消息 patch（已验证可用）加已发卡片登记表——比指示器所需的更重。结算时打 ✅/❌ 标记被推迟为独立的呈现选择；添加-移除的括号就是指示器的全部契约。
