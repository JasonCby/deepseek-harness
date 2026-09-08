---
description: "飞书（Lark）机器人集成包组：聊天事件驱动多轮 DSH 会话并回发回复。"
kind: "package-group"
---

# feishu/ — 飞书机器人到 DSH 会话

[English](README.md) | 中文

## 概述

Feishu 家族把飞书机器人接入 harness：聊天事件经外拨 WSS 长连接或入站 webhook 路由到达，每个会话作为一个多轮根 Session 运行，轮次完成后会话日志中的助手文本经飞书 API 回发。

## 包

- [`feishu`](feishu/) — 机器人插件：入口归一化、会话到 Session 的路由、轮次结算与两条传输边。

## 相关文档

- [飞书机器人 overlay 示例](../../apps/cli/config/examples/feishu-bot/cordis.yml)
- [Webhook 运行时](../webhook/) — 本插件刻意不复用的 fire-and-forget 事件家族
