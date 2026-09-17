# Agent Note: 飞书存活 agent 收养 —— 聊天与 Web UI 共存

Status: implemented

[English](2026-09-11-feishu-live-agent-adoption.md) | 中文

## Problem

agent 注册表拒绝同一 session id 上的第二个存活 agent。API session controller 已在其 resume 的 catch 里恢复该竞争（返回已存活 agent），但飞书路由没有同等恢复：操作员在 Web UI 打开某个聊天会话（其 agent 升为存活）后，下一条聊天消息对同一 id resume、相撞，聊天端以失败通知作答。从 Web UI 督办——本意的共存——反而弄断了聊天通道。

## Decision

`ensureAgent` 在 create/resume 之前检查 `ctx.agents.get(sessionId)`，发现存活 agent 即原样收养。路由的 handle 缓存从 `AgentHandle` 窄化为 `{agent}`：被收养的 agent 不携带 dispose 能力，因为创建它的通道（Web UI 会话视图）拥有收尾；缓存上按消息的存活性复查本来就会在其 agent 被释放后退役该收养条目。飞书 session id（`feishu-<sha256(chatId)>`）与 subagent 子会话不共享命名空间，因此该 id 下的存活 agent 必是普通的跨通道 agent。

## Consequences

- 聊天轮次与 Web UI 轮次在同一 agent 上交错：followup 排在运行中轮次之后，结算提取获准之后落定的一切，因此并发的 Web 轮次助手文本可能混入聊天回复——同一会话的共存属性，本修复不改变它。
- 被收养的 agent 保持其所属通道的组合（Web UI 挂载已记录的 preset——即飞书自己也会挂载的组合），会话的持久模型选择约束两个通道的请求。

## Alternatives considered

冲突时在飞书侧释放对方 agent 被否决：handle 的 dispose 属于创建它的所有者。撞车后从 catch 里重试 resume 被否决：收养不抛错即可到达同一 agent。
