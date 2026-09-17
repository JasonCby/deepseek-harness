# Agent Note: Feishu topic sessions — one session per chat topic

Status: implemented

English | [中文](2026-09-11-feishu-topic-sessions.zh.md)

## Problem

One session per chat collapsed parallel conversations: a group chat running several threads at once interleaved them into one context, and one topic's history leaked into unrelated answers. The product shape is topic-scoped conversations. On the target private deployment the event's `thread_id` (an `omt_`-prefixed stable identity) marks topic messages in topic groups and private chats alike, verified live.

## Decision

Session identity derives from the routing pair: a message without `thread_id` keeps the existing `feishu-<sha256(chatId)>` id, so existing chats resume unchanged; a message inside a topic hashes chat and thread identity together into the same id form (the composite separator cannot occur in a chat id, so the derivation inputs never overlap). Queues, the handle cache, live-agent adoption, and resume all key by the derived Session id — serialization follows the session, so two topics of one chat interleave safely while one session's messages stay ordered. Topic sessions carry the title `Feishu chat <chatId> topic <threadId>` so operators can tell them apart in the Web UI. Routing reads only the event payload — no session event or model-visible input changes, so neither SDK's expected outputs nor the snapshot harness change.

## Consequences

- The main chat's id format is unchanged; topic ids share the form over distinct material — no collision, no migration.
- The group mention gate already covers topic roots (an unmentioned root never reaches ingress); in a regular (non-topic) group a topic reply's root message carries no `thread_id`, so the root lands in the chat's main session while replies land in the topic session — the platform's shape, recorded in the package README.
- The model-visible framing is unchanged: topic messages frame exactly like main-chat messages, and the session boundary itself bounds the context.

## Alternatives considered

A settings switch collapsing topics into the main session was rejected as knob drift — topics are the product shape. Hashing the thread identity alone was rejected in favor of one derivation over the routing pair: one rule, one collision domain. Naming the topic in the prompt frame was deferred: a model-visible change with no present need, since a topic session never sees other topics' history.
