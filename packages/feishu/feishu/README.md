---
description: "Feishu (Lark) bot plugin: chat events over a long connection or webhook route into multi-turn DSH sessions, with replies sent back."
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu

English | [中文](README.zh.md)

## Summary

`dsh-feishu` turns a Feishu (Lark) bot into a DSH front door. Each chat's main stream and topic threads map to their own multi-turn root Session, one per reset generation; every admitted message becomes one ordinary follow-up turn, and the completed turn's assistant text is replied as plain text or one markdown card, followed by the declared files and cards. Two mutually exclusive transport edges carry events — an outbound WSS long connection, and an inbound webhook route on the optional `dsh-host-webserver` — hot-swapping on settings changes. Interactive cards answer in-turn approval and user-question requests; the callback refreshes the settled style.

## Table of Contents

- [Configuration](#configuration)
- [Transports](#transports)
- [Interactive cards](#interactive-cards)
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
| `replyInThread` | Open one topic per main-stream message and answer inside it (default `false`); topic messages always continue their topic, so each question keeps its own session. |
| `replyForm` / `cardTitle` | Reply form: `auto` (default; turns carrying workflow runs or approval asks reply as one markdown card, the rest as text), `text`, or `card` (always one markdown card); `cardTitle` is the card header title (default `DSH`). |
| `thinkingEmoji` | Emoji key bracketing each admitted turn as the thinking indicator (default `Typing`); empty disables the indicator. |
| `replyCharLimit` / `failureNotice` | Reply truncation bound (default 4000, shared by both forms) and the failure reply text. |
| `dedupCapacity` | Remembered message identities for retry deduplication (default 1024). |
| `cardLocale` | Builder multilingual key lifted to `elements`/`header` when a template card is a builder export (default `zh_cn`). |
| `interactionCards` | Interactive approval/question cards: `enabled` (default `false`), approval `pendingCard` (local card JSON 1.0 frame with `{{toolName}}`/`{{reason}}`; the button row is appended) plus `approveLabel`/`rejectLabel`, question `title`/`submitLabel`/`skipLabel`, and per-kind settled style — exactly one of a local `settledCard` frame (`{{outcome}}`/`{{decidedBy}}`/`{{summary}}`) or a platform `settledTemplateId`. Card callbacks follow the console's delivery config: long-connection mode rides the websocket edge, and request-address mode needs the composed WebServer's `<path>/card` route. |
| `cardTemplates` | Registry of card templates for bound tool turns: name, `bindTool` (optional `workflowName` filter), exactly one of platform `templateId` or local `card` carrying `{{variable}}` placeholders, and per-variable extraction rules (a `context` key or a `tool-result` dot path, `required`, `maxLength`). A local card accepts canonical card JSON 1.0 or the builder's multilingual export (`i18n_elements`/`i18n_header`, lifted from `cardLocale`); card JSON 2.0 is rejected by name until a `'v2'` dialect ships. |
| `workspacePath` / `agentPreset` / `permissionPreset` | Deployment-only: the sessions' workspace, agent composition, and sandbox/approval preset. Never editable through settings. |

All fields except the last row form the `feishu` settings namespace (`installSection`), so the settings UI edits them live and a commit hot-swaps the transport edge.

<a id="transports"></a>
## Transports

- **websocket** — the SDK client (`@larksuiteoapi/node-sdk`) dials out, so no public URL, TLS terminator, or challenge handshake is needed. Feishu requires single-connection semantics per app credential; run one DSH instance per app. A credential write re-runs the edge swap through the `credentials/reference-updated` event, so a rotated secret reconnects without a process restart.
- **webhook** — registers one exact route on the composed WebServer (resolved through an optional `ctx.inject` ref; a webhook section without a WebServer fails the settings `validate` hook and the edge start equally loud). Point a TLS reverse proxy at an isolated listener, as the [overlay example](../../../apps/cli/config/examples/feishu-bot/cordis.yml) shows.

<a id="interactive-cards"></a>
## Interactive cards

When a turn's tool call needs approval, or the model calls `ask_user_question`, the bridge (mounted on every chat agent's scoped world) answers the request with one card replied to the turn's anchor message: two buttons whose values carry the interaction identity for approvals, or one generated form for questions. Each option question projects to a select (multi-select when several may be chosen) whose options carry their label as the callback value, ends with the trailing `我在下方输入` hint choice that submit drops, and carries a free-text field beside it; option-less questions project to a text input. On single-select questions custom text replaces the selection at submit — the web composer's one-answer-slot rule — while multi-select keeps both; a skip button outside the form settles every question unanswered. Callbacks reach the plugin through whichever ingress the Feishu console's card-callback delivery config selects — long-connection mode delivers `card.action.trigger` as one more event frame on the websocket edge (the handler's return value is relayed to the platform as the callback response), and request-address mode posts to the `<path>/card` route (verified through the SDK's card handler). Either ingress matches the returned identity back to the pending interaction, resolves the waterfall synchronously (Feishu requires the response within three seconds; the agent's continued turn runs on), and refreshes the card in the callback response itself: the settled card replaces the pending one in place, as a local JSON 1.0 document or a platform template. Without a composed WebServer only the long-connection mode is served, and the skip is logged.

Cards only claim requests of turns this channel is serving: an anchored turn answers with cards, a turn another channel drives passes through `next()`, so the Web UI keeps answering its own sessions. An aborted request settles cancelled; its card cannot refresh without a callback, so a later click meets the already-settled toast. The event subscription and the card-callback delivery config are set independently in the Feishu console; a long-connection message transport pairs naturally with long-connection card callbacks, and request-address card callbacks work beside either message transport.

<a id="service-api"></a>
## Service API

- `sessionIdForChat(chatId, epoch = 0)` — deterministic `feishu-<sha256(chatId#epoch)>` Session id, one per chat generation; a restart resumes the persisted session under the same id with no side-car mapping, and a reset command bumps `epoch` so the chat continues in a fresh session.
- `sessionIdForThread(chatId, threadId, epoch = 0)` — the same derivation hashing the chat, topic, and generation identities; one topic thread is one session beside the chat's main stream.
- `ConversationRouter` — dedup by message id, per-chat queueing, session create/resume (a live agent another channel published for the chat's session, e.g. the Web UI, is adopted instead of resumed), turn settlement from the session log, a best-effort thinking reaction bracketing each admitted turn, and — under `replyInThread` — one bot-opened topic per main-stream message answered in place of the main stream.
- `createTopicOpener` / `topicSummary` — the topic-opening reply (`reply_in_thread`, lead message carrying the single-lined question summary) and its pure summary projection.
- `matchCardTemplate` / `resolveTemplateVariables` / `resolveCardFormat` / `normalizeTemplateCard` / `renderTemplateReply` — the pure card-template pipeline: registry matching over the turn's tool calls, variable extraction from logged tool-result meta and message facts, dialect resolution (canonical 1.0 or builder multilingual export; card JSON 2.0 rejected by name), locale lifting onto the canonical send form, and platform-or-local payload rendering.
- `convertCardV2toV1` — the reserved projector for a future card JSON 2.0 input dialect: lifts `body.elements`, drops 2.0-only keys (keeping the `margin`/`horizontal_spacing` that 1.0 `column_set` carries), and gives bare `img` elements the `alt` 1.0 requires; nothing routes here until a `'v2'` dialect joins `CardInputFormat`.
- `InteractionBridge` — the plugin-scoped interactive-card bridge: per-agent `approval/request` and `user-questions/request` answerers (anchored turns claim, others delegate through `next()`), the pending-interaction table keyed by branded identity, and `dispatch` resolving one admitted callback into the card-refresh response.
- `buildApprovalCard` / `buildQuestionCard` / `buildSettledCard` — the pure card builders: configured frame plus generated buttons/form (option questions to selects carrying their label as the callback value, ending with the dropped `我在下方输入` hint choice, plus a free-text field; option-less to inputs; a skip button outside the form), and the settled projection with `{{outcome}}`/`{{decidedBy}}`/`{{summary}}` placeholders.
- `parseCardAction` — wire validation of one card-action callback down to identity, verdict, form values, and operator.
- `CardCallbackController` — serialized lifecycle of the `<path>/card` route; `reconfigure()` follows settings commits and credential updates, and a disabled section unregisters it.
- `EdgeController` — serialized edge lifecycle; `reconfigure()` stops the active edge and starts the one the current settings select.
- `larkSdk` — the narrow SDK surface (`createApiClient`, `createWsClient`, `createDispatcher`, `generateChallenge`), injectable in tests.
- `renderMarkdownCard` — the pure settled-text → card-JSON-1.0 projection (fixed blue header carrying `cardTitle`, one markdown element) the `card` reply form sends.

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
- **Topic sessions key on `thread_id`** — messages carrying a topic identity route to a per-topic session; in a regular (non-topic) group a topic reply's root message carries no `thread_id`, so the root lands in the chat's main session.
- **`replyInThread` needs the thread-opening reply on the deployment** — verified on the SaaS p2p and regular-group surfaces; a private deployment that refuses `reply_in_thread` degrades every affected turn to an in-place reply (logged), never to a lost one.
- **Template delivery falls back loudly** — an unresolvable or over-long variable and a Feishu refusal of the template content each downgrade the reply to the markdown card (logged); a local card's `img_key` belongs to the app that uploaded the image.
- **Feishu markdown is a subset** — card-form replies render in Feishu's markdown dialect; GFM tables and other unsupported syntax degrade inside the card.
- **Card validation stops at the `elements` array** — the tool rejects only payloads that cannot be a card at all, so a card that violates the rest of Feishu's card schema is refused by the Feishu API, logged, and skipped while the remaining cards and files still go out.
- **Resumed chats use the deployment's default model route** — a model switch made from the Web UI does not survive a process restart for chat sessions.
- **Unencrypted webhooks carry no signature check** — with an empty encrypt key the SDK dispatcher accepts unsigned bodies; such deployments rely on route secrecy (see the GitHub webhook guide for the isolated-listener pattern).
- **The card-callback delivery mode lives in the Feishu console** — long-connection mode needs no route; request-address mode needs the composed WebServer and its `<path>/card` route, which is skipped with a logged warn when no WebServer is composed.
- **A static form cannot clear a picked option when custom text arrives** — single-select questions resolve the clash at submit (custom text replaces the selection, matching the web composer), and the trailing `我在下方输入` hint choice lets the user visibly unselect instead; menus have no live field linkage.
- **An aborted interaction leaves its card pending** — without a callback there is no in-place refresh; the settled toast answers the next click, and the card entity update APIs (JSON 2.0 only) stay out of scope.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The transport-agnostic core deliberately bypasses `dsh-webhook`'s runtime: chat continuity, completion settlement, and the outbound reply path do not fit its one-shot fire-and-forget contract. The optional WebServer must be consumed through `ctx.inject` because loader entries are realm-isolated; a dynamic `ctx.get` from the plugin context resolves nothing. Design rationale and rejected alternatives: [Agent Note](../../../.agents/notes/implemented/architecture/2026-09-08-feishu-bot-plugin.md). Card replies are recorded in [their own note](../../../.agents/notes/implemented/architecture/2026-09-10-feishu-card-replies.md); automatic per-turn form routing in [the auto-form note](../../../.agents/notes/implemented/architecture/2026-09-10-feishu-auto-reply-form.md); cross-channel live-agent adoption in [the adoption note](../../../.agents/notes/implemented/architecture/2026-09-11-feishu-live-agent-adoption.md); the thinking reaction in [its own note](../../../.agents/notes/implemented/architecture/2026-09-11-feishu-thinking-reaction.md); topic sessions in [the topic note](../../../.agents/notes/implemented/architecture/2026-09-11-feishu-topic-sessions.md); bot-opened topics in [the reply-in-thread note](../../../.agents/notes/implemented/architecture/2026-09-11-feishu-reply-in-thread.md); card templates in [the templates note](../../../.agents/notes/implemented/architecture/2026-09-11-feishu-card-templates.md); interactive cards and their callback bridge in [the card-interactions note](../../../.agents/notes/implemented/architecture/2026-09-14-feishu-card-interactions.md); card delivery and chat generations in [the session-reset note](../../../.agents/notes/implemented/feature/2026-09-16-feishu-interactive-cards-and-session-reset.md).

</details>
