# Agent Note: Feishu thinking reaction — one Typing emoji brackets each turn

Status: implemented

English | [中文](2026-09-11-feishu-thinking-reaction.zh.md)

## Problem

A chat turn runs for seconds to minutes with no visible activity: the sender cannot distinguish thinking from silence. Feishu offers bots no typing indicator, but message reactions are open to them.

## Decision

One best-effort reaction brackets each admitted turn: `process()` adds the configured emoji (`thinkingEmoji`, default `Typing` — the keyboard face, verified live: add and remove both returned code 0 under the app's existing scopes) to the inbound message before the turn starts and removes it in a `finally` after the reply or failure notice. Reaction failures only log — the indicator must never fail a turn — so between edges a silent placeholder sender stands in, unlike the reply placeholder that rejects loudly. `createReactionSender` (new `reaction.ts`) rides the edge's API client beside the reply sender and is wired in `EdgeController.activate`; the narrow `LarkApiClient` surface gains `im.v1.messageReaction` create/delete. No session event, model-visible input, or loop change — the indicator derives from the turn lifecycle — so neither SDK's expected outputs nor the snapshot harness change.

## Consequences

- The indicator spans exactly the admitted turn: queue-wait time before admission shows nothing, because the message was not yet accepted.
- Feishu restricts deletion to reactions the app itself added; the remove call carries the identity the add call returned, and a response without an identity leaves the reaction in place.
- An empty `thinkingEmoji` disables the indicator; deployments whose emoji set lacks `Typing` substitute their own key through the settings section. The loader-composition fixture disables it so the composition test makes no reaction API call.

## Alternatives considered

A streamed "thinking…" card replaced on settlement was deferred to the progress-card phase: it needs `im` message patch (verified available) plus a sent-card registry — heavier than the indicator needs. Settlement-time ✅/❌ marks were deferred as a separate presentation choice; the add-remove bracket is the indicator's whole contract.
