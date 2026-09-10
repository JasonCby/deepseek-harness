---
description: "Feishu (Lark) bot plugin: chat events over a long connection or webhook route into multi-turn DSH sessions, with replies sent back."
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu

English | [中文](README.zh.md)

## Summary

`dsh-feishu` turns a Feishu (Lark) bot into a DSH front door. Each Feishu chat maps to one multi-turn root Session; every admitted message becomes one ordinary follow-up turn; and the assistant text the completed turn leaves in the session log is replied through the Feishu API as plain text or one markdown card. Two mutually exclusive transport edges carry events — an outbound WSS long connection that needs no public URL, and an inbound webhook route on an optionally composed `dsh-host-webserver` — and the active edge hot-swaps when the `feishu` settings section changes.

## Table of Contents

- [Configuration](#configuration)
- [Transports](#transports)
- [Service API](#service-api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="configuration"></a>
## Configuration

| Key | Meaning |
|---|---|
| `transport` | `websocket` (default) or `webhook`. |
| `domain` | `feishu` (default), `lark`, or a self-hosted deployment's complete API origin (`https://…`). |
| `appIdEnv` / `appSecretEnv` | Credential references resolved per edge start; literals `appId`/`appSecret` win when set. |
| `verificationTokenEnv` / `encryptKeyEnv` | Webhook-only credential references (SDK dispatcher verification). |
| `path` / `maxBodyBytes` | Webhook route path (default `/feishu`) and body ceiling (default 65536). |
| `allowChatIds` | Chats the bot answers; empty (default) answers every chat that reaches it. |
| `groupRequireMention` | In groups, answer only mentioned messages (default `true`). |
| `replyForm` / `cardTitle` | Reply form: `text` (default) or `card` (one markdown card); `cardTitle` is the card header title (default `DSH`). |
| `replyCharLimit` / `failureNotice` | Reply truncation bound (default 4000, shared by both forms) and the failure reply text. |
| `dedupCapacity` | Remembered message identities for retry deduplication (default 1024). |
| `workspacePath` / `agentPreset` / `permissionPreset` | Deployment-only: the sessions' workspace, agent composition, and sandbox/approval preset. Never editable through settings. |

All fields except the last row form the `feishu` settings namespace (`installSection`), so the settings UI edits them live and a commit hot-swaps the transport edge.

<a id="transports"></a>
## Transports

- **websocket** — the SDK client (`@larksuiteoapi/node-sdk`) dials out, so no public URL, TLS terminator, or challenge handshake is needed. Feishu requires single-connection semantics per app credential; run one DSH instance per app.
- **webhook** — registers one exact route on the composed WebServer (resolved through an optional `ctx.inject` ref; a webhook section without a WebServer fails the settings `validate` hook and the edge start equally loud). Point a TLS reverse proxy at an isolated listener, as the [overlay example](../../../apps/cli/config/examples/feishu-bot/cordis.yml) shows.

<a id="service-api"></a>
## Service API

- `sessionIdForChat(chatId)` — deterministic `feishu-<sha256(chatId)>` Session id; a restart resumes the persisted session under the same id with no side-car mapping.
- `ConversationRouter` — dedup by message id, per-chat queueing, session create/resume, turn settlement from the session log.
- `EdgeController` — serialized edge lifecycle; `reconfigure()` stops the active edge and starts the one the current settings select.
- `larkSdk` — the narrow SDK surface (`createApiClient`, `createWsClient`, `createDispatcher`, `generateChallenge`), injectable in tests.
- `renderMarkdownCard` — the pure settled-text → card-JSON-1.0 projection (fixed blue header carrying `cardTitle`, one markdown element) the `card` reply form sends.

Each admitted chat message is appended as one `user/message` whose source is `{ kind: 'feishu', chatId, messageId, form: 'notice', summary }` (declaration-merged into `MessageSourceMap`).

## Model Experience

### Feishu chat prompt

#### What the model sees

One `user/message` per admitted chat message. The prompt text is one fixed framing line — `Feishu chat message (untrusted external input; chat {chatId}, sender {senderOpenId}):` with `{chatId}` and `{senderOpenId}` interpolated (`unknown` when the event carries no sender id) — followed by a blank line and the sender-written message text, which owns no trust and no length bound of its own.

#### Token effect

Data-dependent: one prompt per admitted message. Retries are deduplicated before the prompt exists, and allowlist or mention gates drop messages with zero tokens.

#### KV Cache effect

Append-only: each admitted message extends the conversation. Settings changes never rewrite history; a transport hot-swap touches only the edges, not the session log.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Reply delivery is best-effort** — a process crash between turn settlement and the Feishu API call loses that reply; there is no retry queue or durable outbox.
- **Events during a transport swap are lost** — the WSS long connection has no replay and the webhook route unregisters for the swap window (seconds).
- **Single instance per Feishu app** — Feishu's cluster mode delivers each event to one random connection, so two DSH processes on one app credential drop events randomly.
- **Inbound text messages only** — non-text chat types and message cards are dropped at ingress normalization; outbound replies take the configured `replyForm` (text or card).
- **Feishu markdown is a subset** — card-form replies render in Feishu's markdown dialect; GFM tables and other unsupported syntax degrade inside the card.
- **Resumed chats use the deployment's default model route** — a model switch made from the Web UI does not survive a process restart for chat sessions.
- **Unencrypted webhooks carry no signature check** — with an empty encrypt key the SDK dispatcher accepts unsigned bodies; such deployments rely on route secrecy (see the GitHub webhook guide for the isolated-listener pattern).

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The transport-agnostic core deliberately bypasses `dsh-webhook`'s runtime: chat continuity, completion settlement, and the outbound reply path do not fit its one-shot fire-and-forget contract. The optional WebServer must be consumed through `ctx.inject` because loader entries are realm-isolated; a dynamic `ctx.get` from the plugin context resolves nothing. Design rationale and rejected alternatives: [Agent Note](../../../.agents/notes/implemented/architecture/2026-09-08-feishu-bot-plugin.md). Card replies are recorded in [their own note](../../../.agents/notes/implemented/architecture/2026-09-10-feishu-card-replies.md).

</details>
