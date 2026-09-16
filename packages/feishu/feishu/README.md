---
description: "Feishu (Lark) bot plugin: chat events over a long connection or webhook route into multi-turn DSH sessions, with replies sent back."
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu

English | [中文](README.zh.md)

## Summary

`dsh-feishu` turns a Feishu (Lark) bot into a DSH front door. Each Feishu chat maps to one multi-turn root Session per generation; every admitted message becomes one ordinary follow-up turn; and the assistant text the completed turn leaves in the session log is replied through the Feishu API, followed by the deliverable files and interactive cards that turn declared. Two mutually exclusive transport edges carry events — an outbound WSS long connection that needs no public URL, and an inbound webhook route on an optionally composed `dsh-host-webserver` — and the active edge hot-swaps when the `feishu` settings section changes.

## Table of Contents

- [Configuration](#configuration)
- [Transports](#transports)
- [Service API](#service-api)
- [Chat commands](#chat-commands)
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
| `replyCharLimit` / `failureNotice` | Reply truncation bound (default 4000) and the failure reply text. |
| `dedupCapacity` | Remembered message identities for retry deduplication (default 1024). |
| `workspacePath` / `agentPreset` / `permissionPreset` | Deployment-only: the sessions' workspace, agent composition, and sandbox/approval preset. Never editable through settings. |

All fields except the last row form the `feishu` settings namespace (`installSection`), so the settings UI edits them live and a commit hot-swaps the transport edge.

<a id="transports"></a>
## Transports

- **websocket** — the SDK client (`@larksuiteoapi/node-sdk`) dials out, so no public URL, TLS terminator, or challenge handshake is needed. Feishu requires single-connection semantics per app credential; run one DSH instance per app. A credential write re-runs the edge swap through the `credentials/reference-updated` event, so a rotated secret reconnects without a process restart.
- **webhook** — registers one exact route on the composed WebServer (resolved through an optional `ctx.inject` ref; a webhook section without a WebServer fails the settings `validate` hook and the edge start equally loud). Point a TLS reverse proxy at an isolated listener, as the [overlay example](../../../apps/cli/config/examples/feishu-bot/cordis.yml) shows.

<a id="service-api"></a>
## Service API

- `sessionIdForChat(chatId, epoch = 0)` — deterministic `feishu-<sha256(chatId#epoch)>` Session id, one per chat generation; a restart resumes the persisted session under the same id with no side-car mapping, and a reset command bumps `epoch` so the chat continues in a fresh session.
- `ConversationRouter` — dedup by message id, per-chat queueing, session create/resume, turn settlement from the session log.
- `EdgeController` — serialized edge lifecycle; `reconfigure()` stops the active edge and starts the one the current settings select.
- `larkSdk` — the narrow SDK surface (`createApiClient`, `createWsClient`, `createDispatcher`, `generateChallenge`), injectable in tests.

Each admitted chat message is appended as one `user/message` whose source is `{ kind: 'feishu', chatId, messageId, form: 'notice', summary }` (declaration-merged into `MessageSourceMap`).

<a id="chat-commands"></a>
## Chat commands

One admitted message whose trimmed text is exactly `/new`, `/reset`, or `/新会话` moves the chat to a new session generation instead of reaching the agent: the router unbinds the chat's routing handle, advances the generation ceiling, persists it, and replies with a notice naming the new generation (`已开启新会话（#n）。…`). The next ordinary message starts the new session, while the retired session keeps its persisted log, stays openable in the Web UI, and remains switchable.

Two more commands manage the generations, also never reaching the agent:

- `/sessions` — lists every generation newest-first (generation number, short session id, creation time), marking the one currently routed; generations a `/new` left unused are marked 未使用; capped at the most recent 20. Angle brackets copied from the usage text (`/switch <1>`) parse the same as a bare number.
- `/switch <n>` — moves the routing pointer to generation `n`; the next message resumes (or borrows) that session through the ordinary path. Out-of-range or malformed arguments answer with usage and change nothing.

Generations live in `feishu-router-state.json` under `$DSH_HOME` (default `~/.dsh`) as `{chatId: {current, max}}`, loaded on first use and replaced atomically; a missing or unreadable file starts every chat at generation 0, and a legacy `{chatId: number}` file migrates to `{current: n, max: n}`. `/new` always opens `max + 1` — after a `/switch` back, `current + 1` would collide with an existing session id.

## Model Experience

### Feishu chat prompt

#### What the model sees

One `user/message` per admitted chat message. The prompt text is one fixed framing line — `Feishu chat message (untrusted external input; chat {chatId}, sender {senderOpenId}):` with `{chatId}` and `{senderOpenId}` interpolated (`unknown` when the event carries no sender id) — followed by a blank line and the sender-written message text, which owns no trust and no length bound of its own. Image and file messages carry one `file` content block per attachment (the LLM runtime projects each to a read-only host path the model reads with its file tools) plus an `Attachments:` line naming them; a message with no text stands in with `(no text; this message carries only attachments)`.

#### Token effect

Data-dependent: one prompt per admitted message. Retries are deduplicated before the prompt exists, and allowlist or mention gates drop messages with zero tokens.

#### KV Cache effect

Append-only: each admitted message extends the conversation. Settings changes never rewrite history; a transport hot-swap touches only the edges, not the session log.

### Deliverable files and cards (`feishu_deliver`)

#### What the model sees

The tool's schema: an optional `paths` array of absolute file paths and an optional `cards` array of Feishu interactive card JSON objects. The description instructs the model to call it once per turn with final deliverables only — never intermediate artifacts — and states the immediate validation (an existing, non-empty file under Feishu's 30 MB cap; a card object carrying an `elements` array). A call answers with `Delivery queue: <n> files accepted (<names>), <m> files rejected; <c> cards accepted, <d> cards rejected.` After the turn settles, the router replays the turn's deliver calls from the session log: each distinct declared card replies first as an `msg_type: 'interactive'` message, then each declared file uploads (`im/v1/files`, type `stream`) as its own file message. One card or upload failing is logged and never fails the turn, and at most 20 cards plus 20 files go out per turn.

#### Token effect

Fixed schema cost on every request where the tool is visible; the paths and cards the model submits persist in the call arguments until compaction. Delivery itself reads the durable log only and costs no model tokens.

#### KV Cache effect

Prefix-stable while the definition is unchanged; the tool mounts identically on created, resumed, and borrowed chat sessions.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Reply delivery is best-effort** — a process crash between turn settlement and the Feishu API call loses that reply; there is no retry queue or durable outbox.
- **Events during a transport swap are lost** — the WSS long connection has no replay and the webhook route unregisters for the swap window (seconds).
- **Single instance per Feishu app** — Feishu's cluster mode delivers each event to one random connection, so two DSH processes on one app credential drop events randomly.
- **Text, image, and file messages only** — other chat types (audio, video, stickers, message cards) are dropped at ingress normalization. Images arrive as file blocks, not native vision: the model reads them through its file tools, and a vision-capable model does not see image bytes natively.
- **Attachment downloads are in-turn and unretried** — each attachment is downloaded when its message is processed; a download or save failure fails the whole turn with the failure notice, and Feishu caps message resources at 100 MB.
- **Deliveries depend on the model calling `feishu_deliver`** — files the turn never declare stay in the workspace only; one file is capped at 30 MB (Feishu's messaging-upload limit) and arrives as a downloadable file message, with no inline image preview.
- **Card validation stops at the `elements` array** — the tool rejects only payloads that cannot be a card at all, so a card that violates the rest of Feishu's card schema is refused by the Feishu API, logged, and skipped while the remaining cards and files still go out.
- **Resumed chats use the deployment's default model route** — a model switch made from the Web UI does not survive a process restart for chat sessions.
- **Unencrypted webhooks carry no signature check** — with an empty encrypt key the SDK dispatcher accepts unsigned bodies; such deployments rely on route secrecy (see the GitHub webhook guide for the isolated-listener pattern).

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The transport-agnostic core deliberately bypasses `dsh-webhook`'s runtime: chat continuity, completion settlement, and the outbound reply path do not fit its one-shot fire-and-forget contract. The optional WebServer must be consumed through `ctx.inject` because loader entries are realm-isolated; a dynamic `ctx.get` from the plugin context resolves nothing. Design rationale and rejected alternatives: [Agent Note](../../../.agents/notes/implemented/architecture/2026-09-08-feishu-bot-plugin.md). Card delivery and chat generations: [Agent Note](../../../.agents/notes/implemented/feature/2026-09-16-feishu-interactive-cards-and-session-reset.md).

</details>
