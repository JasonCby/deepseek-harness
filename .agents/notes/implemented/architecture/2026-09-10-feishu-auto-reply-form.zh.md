# Agent Note: 飞书 auto 回复形式 —— 结构化轮次结算为卡片

Status: implemented

[English](2026-09-10-feishu-auto-reply-form.md) | 中文

## Problem

回复形式曾是单一全局设置：一个部署要么每轮回文本，要么每轮回卡片。产品方向需要在同一会话里两者共存——普通问答是聊天消息，工作流与审批轮次是可读性好的卡片——且规划中的模板与出卡工具阶段需要一个按轮的卡片决策来挂接它们的解析链。

## Decision

`replyForm` 增加 `auto`（新默认值）。结算经一个纯分类器 `resolveReplyForm(form, events, fromSeq)` 按轮解析形式：`text` 与 `card` 原样透传；`auto` 扫描本轮日志窗口，携带结构化标记——`tool-workflow/` 事件族（前缀匹配；该族可合并扩展）或 `approval/asked`——时结算为卡片。路由的 `payload()` 接收已解析的具体形式，显式解析步骤不留在投递时分支里。失败通知永不参与分类：`auto` 下保持文本，因为失败轮次没有可呈现的结构。仍是已落日志状态的纯投影——无 session 事件、模型可见输入或 loop 变更——因此两个 SDK 的期望输出与 keyless 快照测试均不变，与插件落地先例一致。

## Consequences

- 默认值从 `text` 翻转为 `auto` 只影响全新部署；pre-release，不做兼容垫片。
- 标记集合是后续阶段扩展的接缝：模板注册表（触发源绑定的模板）与 `present_card` 工具将作为额外卡片来源，排在解析顺序中 markdown 投影之前。
- 运行普通工具（bash、文件系统）的轮次保持文本——只有工作流运行与审批询问参与分类，对应「问答是消息，加载的工作流是卡片」。

## Alternatives considered

按回复内容分类（markdown 启发式）被否决：呈现跟随已记录的结构，不跟随散文形状。命令强制形式（`/card` 前缀）推迟到 commands 接缝。`auto` 下把失败通知按分类结果发卡片被否决，维持单一规则：除非设置显式为 `card`，通知一律文本。
