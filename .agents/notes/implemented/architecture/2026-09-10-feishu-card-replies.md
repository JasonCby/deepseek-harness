# Agent Note: Feishu card replies — settled text as one markdown card

Status: implemented

English | [中文](2026-09-10-feishu-card-replies.zh.md)

## Problem

The bot's only outbound form was plain text (`msg_type: 'text'`, truncated at 4000 characters), so a settled turn's markdown structure collapsed into a chat bubble. Supervision and approval use cases need presentable output, and Feishu's reply API natively accepts interactive cards — the constraint was this package's own narrowed sender, not the platform.

## Decision

Card replies are a pure projection of already-logged state. `renderMarkdownCard` (new `card.ts`) wraps the settled text — the same `extractReplyText` output under the same `replyCharLimit` — into one card-JSON-1.0 card: a fixed blue header carrying the configured `cardTitle` plus a single markdown element. `ReplySender` carries a closed `ReplyContent` union (`text` | `card`) switched through `assertNever`; the conversation router owns an explicit `payload()` resolve step keyed on the `replyForm` setting, and the failure notice follows the same form. The `LarkSdk` reply surface widened to `msg_type: 'text' | 'interactive'`, matching the official reply API's card support. No session event, model-visible input, or loop change is involved — cards derive from the durable log — so neither SDK's expected outputs change and the keyless snapshot harness (which projects shipped profiles only) has no feishu case, matching the plugin's landing precedent.

## Consequences

- `replyForm` (default `text`) and `cardTitle` (default `DSH`) are settings-section fields: hot-applied and validated non-empty, not yet card-edited in the settings UI (the same subset precedent as `appIdEnv`).
- Feishu markdown is a subset of GFM (tables unsupported); card-form rendering degrades unsupported syntax — recorded in the package README's known limitations.
- Card update/patch (progress refresh) is deliberately out of scope: it needs mid-turn event consumption and a sent-card message-id registry — the outbox-shaped state the best-effort delivery limitation already flags. The `ReplyContent` discriminant union is the reserved extension point.

## Alternatives considered

Card JSON 2.0 was deferred: only CardKit streaming updates require it, and the im reply/patch message APIs the bot uses support 1.0. A separate `sendCard` function beside the text sender was rejected in favor of one payload union — a single wire path and one discriminant to extend later. Separate truncation bounds for text and card were rejected as knob drift; one bound covers both forms.
