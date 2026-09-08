# Agent Note: Feishu bot — chats as Sessions, transports as hot-swapped settings edges

Status: implemented

English | [中文](2026-09-08-feishu-bot-plugin.zh.md)

## Problem

The harness had no Feishu (Lark) integration, and the two existing seams that look like starting points do not fit a chat bot. `dsh-webhook`'s runtime is fire-and-forget with a fresh one-shot Session per delivery — no multi-turn continuity, no completion callback, no outbound path back to the chat. `dsh-acp` has exactly the right settlement semantics (prompt admission, quiescence, assistant-text collection), but it is a stdio JSON-RPC server: driving Feishu through it would mean a second deployed process whose sessions the Web UI cannot see. A chat bot additionally needs to answer within Feishu's 3-second event acknowledgement window while an agent turn runs far longer.

## Decision

One plugin, `@deepseek-ai/dsh-feishu`, with a transport-agnostic core and two mutually exclusive edges. The core maps each chat to one deterministic Session id (`feishu-<sha256(chatId).slice(0,32)>`), so restart recovery is a `sessionPersistence.list()` membership check — create or `agents.resume`, no side-car mapping. Resume mounts the session header's durable `agentPreset` so replayed history stays actionable. Settlement captures `session.events.length` before `followup`, awaits `agent.whenIdle()`, and extracts `assistant/message` text from that seq onward: the durable log is the reply's source of truth. Ingress does only dedup-by-`message_id` (Feishu re-pushes until acknowledged), allowlist/mention gates, and per-chat queueing — everything slow happens after the 3-second ack. The two edges are an outbound WSS long connection through `@larksuiteoapi/node-sdk` (no public URL; token caching, heartbeat, and reconnect are SDK-owned, and `reConnect` is never called to avoid the upstream timer leak) and an inbound webhook route whose authentication stays inside the SDK dispatcher (challenge, AES envelope, signature). The `feishu` settings namespace (`installSection`) carries transport, credential refs, allowlist, and reply limits; `workspacePath`/`agentPreset`/`permissionPreset` stay composition-only so the settings UI can never raise a chat session's permissions. A committed change hot-swaps the edge through `EdgeController`'s serialized stop/start chain, and replies reuse the active edge's API client so credential changes rebuild both together.

One non-obvious mechanism: loader entries are realm-isolated, so `ctx.get('webServer')` from the plugin context resolves nothing. The optional WebServer is therefore consumed through `ctx.inject(['webServer'], …)` maintaining a ref; the settings `validate` hook and the webhook edge start fail loud when the ref is empty, and the ref's arrival re-runs a previously blocked webhook edge. The REAL loader-composition test found this — unit stubs on a bare `Context` could not.

## Consequences

- Feishu event retries are deduplicated in `ConversationRouter.accept` before any queueing; per-chat queues also serialize session creation against a second message racing it.
- `whenIdle()` settlement follows replacement work by repo semantics; the per-chat queue keeps a later Feishu message from extending settlement, but concurrent Web-UI input on the same session is followed to quiescence — accepted and documented in the package README.
- Known limits recorded in the package README: best-effort reply delivery (no outbox), events lost during a transport swap or WSS disconnect, single instance per Feishu app (cluster-mode random unicast), text messages only, resumed chats use the deployment's default model route, and unencrypted webhooks rely on route secrecy.

## Alternatives considered

Reusing `dsh-webhook` was rejected on contract mismatch (one-shot sessions, no completion callback, no outbound path). An ACP sidecar process was rejected as a second deployment unit with Web-UI-invisible sessions. Hand-rolling the WSS protocol was rejected because the long-connection wire protocol is undocumented and the SDK already owns token caching and reconnect. A dedicated completion-event plugin hook in `agent-loop` was rejected because the session log already carries everything settlement needs; adding a loop extension point would violate the plugins-not-loop-changes rule for no new capability.
