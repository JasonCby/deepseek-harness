# Agent Note: Feishu reply-in-thread — one bot-opened topic per question

Status: implemented

English | [中文](2026-09-11-feishu-reply-in-thread.zh.md)

## Problem

Topic routing alone leaves topic creation to users, but the enterprise shape is the inverse: a user asks in the main stream, the digital employee answers inside a topic rooted at that question, and follow-ups continue the topic — one question one bounded session, with the main stream as a clean index. The reply API's `reply_in_thread` body flag opens exactly such a topic; verified live on the SaaS p2p surface (a p2p chat confirmed `chat_mode=p2p`; the thread-opening reply returned `thread_id`, and a follow-up reply without the flag landed in the same thread).

## Decision

Under the `replyInThread` setting (default off), `process()` opens the topic before the turn runs: `createTopicOpener` (new `topic.ts`) replies to the admitted main-stream message with `reply_in_thread: true` and a lead carrying `topicSummary(text)` — the message single-lined and truncated to a fixed 64-character bound — and the response must carry both the lead message id and `thread_id`, else the open fails. The turn then routes through the synthesized `(chatId, threadId)` message into the topic session (the PR-B derivation), and the settled reply and failure notice target the lead message, staying inside the topic. Messages already inside a topic never open another. A refused or failed open degrades the turn to an in-place main-stream reply (logged); between edges an unreachable opener placeholder degrades the same way, while the reply placeholder keeps failing loudly. No session event, model-visible input, or loop change.

## Consequences

- With the setting on, every main-stream question lands in its own topic session by construction — the main session stops accumulating, and cross-question context pollution disappears without a separate lifecycle policy.
- The topic's root is the user's own message; the bot's lead is the first in-thread message (the question summary), doubling as the moved-to-topic affordance.
- The dependency is one platform behavior: the thread-opening reply. Verified on SaaS p2p and documented for regular groups; a private deployment that refuses it degrades turns in place rather than losing them, recorded in the package README.

## Alternatives considered

Running the turn first and opening the topic with the answer was rejected: the `thread_id` exists only after the opening call, so the session identity would postdate the turn. Keying topic sessions by root message id (the OpenClaw trick) was rejected: it re-keys PR-B's scheme and depends on `root_id` where `thread_id` is the canonical identity. A settings knob for main-session lifetime ("persistent" vs "per-question") was rejected as redundant — the setting already implies per-question by construction.
