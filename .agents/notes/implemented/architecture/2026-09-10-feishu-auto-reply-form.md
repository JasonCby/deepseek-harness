# Agent Note: Feishu auto reply form — structured turns settle as cards

Status: implemented

English | [中文](2026-09-10-feishu-auto-reply-form.zh.md)

## Problem

The reply form was one global setting: a deployment replied to every turn as text or to every turn as a card. The product direction needs both in one chat — plain Q&A as chat messages, workflow and approval turns as presentable cards — and the planned template and card-tool phases need a per-turn card decision to hang their resolution chain on.

## Decision

`replyForm` gains `auto` (the new default). Settlement resolves the form per turn through one pure classifier, `resolveReplyForm(form, events, fromSeq)`: `text` and `card` pass through unchanged; `auto` scans the turn's log window and settles as a card when it carries structured markers — the `tool-workflow/` event family (prefix match; the family is merge-extensible) or `approval/asked`. The router's `payload()` takes the already-resolved concrete form, keeping the explicit resolve step out of delivery-time branching. Failure notices never classify: under `auto` they stay text, because a failed turn leaves no presentable structure. Still a pure projection of logged state — no session event, model-visible input, or loop change — so neither SDK's expected outputs nor the keyless snapshot harness change, matching the plugin's landing precedent.

## Consequences

- The default flip from `text` to `auto` affects fresh deployments only; pre-release, no compatibility shim.
- The marker set is the seam later phases extend: the template registry (trigger-bound templates) and the `present_card` tool join as additional card sources ahead of the markdown projection in the resolution order.
- A turn that runs ordinary tools (bash, filesystem) stays text — only workflow runs and approval asks classify, matching "Q&A is a message, a loaded workflow is a card".

## Alternatives considered

Classifying from reply content (markdown heuristics) was rejected: presentation follows logged structure, not prose shape. Command-forced forms (a `/card` prefix) were deferred to the commands seam. Sending failure notices as classified cards under `auto` was rejected in favor of one rule: notices are text unless the setting is explicitly `card`.
