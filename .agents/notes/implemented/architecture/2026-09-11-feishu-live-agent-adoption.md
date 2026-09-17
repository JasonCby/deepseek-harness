# Agent Note: Feishu live-agent adoption — chat coexists with the Web UI

Status: implemented

English | [中文](2026-09-11-feishu-live-agent-adoption.zh.md)

## Problem

The agent registry rejects a second live agent on one session id. The API session controller already recovers from that race by returning the live agent from its resume catch, but the Feishu router had no such recovery: once an operator opened a chat session in the Web UI (promoting its agent live), the next chat message resumed the same id, collided, and the chat answered with the failure notice. Supervision from the Web UI — the intended coexistence — broke the chat channel.

## Decision

`ensureAgent` checks `ctx.agents.get(sessionId)` before create/resume and adopts a live agent as-is. The router's handle cache narrows from `AgentHandle` to `{agent}`: an adopted agent carries no dispose capability, because the channel that created it (the Web UI session view) owns teardown; the per-message liveness re-check on the cache already retires an adopted handle whose agent was disposed. Feishu session ids (`feishu-<sha256(chatId)>`) share no namespace with subagent children, so any live agent under the id is an ordinary cross-channel agent.

## Consequences

- A chat turn and a Web UI turn interleave on one agent: followup queues behind the running turn, and settlement extracts everything settled after admission, so a concurrent Web turn's assistant text can ride into the chat reply — a same-session coexistence property, unchanged by this fix.
- The adopted agent keeps its owning channel's composition (the Web UI mounts the logged preset — the composition Feishu mounts itself), and the session's durable model selection governs both channels' requests.

## Alternatives considered

Disposing the colliding agent on the Feishu side was rejected: the handle's dispose belongs to the owner that created it. Retrying resume from a collision catch was rejected: adoption reaches the same agent without first throwing.
