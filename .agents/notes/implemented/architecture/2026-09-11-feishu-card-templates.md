# Agent Note: Feishu card templates — registry, variables, and the workflow meta foundation

Status: implemented

English | [中文](2026-09-11-feishu-card-templates.zh.md)

## Problem

Structured turns replied as one fixed markdown projection card. The enterprise shape needs tenant-designed cards — built in the Feishu card builder — with data filled deterministically, and the data source for workflow turns, the run's return value, was not durable: `tool-workflow/run-end` carries only `{runId, stopReason}`, and the model-facing result text is not a structured source.

## Decision

Two slices. `dsh-tool-workflow` projects `output.presentationMeta` — `{runId, name, result}` bounded by the same `maxResultChars` budget as the rendered text; an oversized result is omitted whole, because a truncated JSON document would read as present-but-wrong — and the projection lands in the durable `tool/result.meta`. The Feishu package gains a pure pipeline over that logged state: `matchCardTemplate` binds the registry's first entry whose `bindTool` ran in the turn's window (an optional `workflowName` secondary filter reads the run's display name); `resolveTemplateVariables` extracts declared variables from message facts (`chatId`, `senderOpenId`, `threadId`) and dot paths into the bound tool result's meta — a missing required variable or an over-`maxLength` value rules the template out; `renderTemplateReply` emits a platform template reference (`{type: 'template', data: {template_id, template_variable}}`) or interpolates `{{variable}}` placeholders into a local card JSON 1.0 skeleton; `convertCardV2toV1` projects builder-exported 2.0 documents onto 1.0 (body lifted, 2.0-only keys dropped, bare images gain `alt`) — the mapping verified live against the reply endpoint on the SaaS p2p surface. Card-form resolution (explicit `card` and `auto` alike) tries the template chain first and falls back to the markdown projection; a refused template delivery retries once as the projection, so a misconfigured template never loses the answer. The three workflow-replaying snapshot fixtures were refreshed (`DSH_SNAPSHOT=refresh`); the new `meta` line is their only diff.

## Consequences

- Bindings key on tool names, the stable logged identity: the generic `workflow` tool binds coarsely until fixed-flow tools exist (the tool-ralph shape), at which point per-flow templates become exact.
- `tool/result.meta` is now durable for workflow calls; template variables are pure projections of that state, so replay reproduces the card. No model-visible input changed.
- A local card's `img_key` belongs to the app that uploaded the image; cross-app keys are refused at send (observed as the generic 230099).

## Alternatives considered

Binding by the workflow display name alone was rejected: the name is model-chosen per call, not a deployment identity. Silent truncation of over-long variables was rejected: display truncation would read as data. A `modelUsable` template flag was deferred to the card-tool PR — a whitelist with no reader is dead config.
