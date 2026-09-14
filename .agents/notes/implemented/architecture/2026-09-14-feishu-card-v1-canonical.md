# Agent Note: Feishu cards are canonical card JSON 1.0 on the wire

Status: implemented

English | [中文](2026-09-14-feishu-card-v1-canonical.zh.md)

## Problem

Card-template configuration assumed tenants would supply card JSON 2.0 builder exports, but what tenants actually export from the Feishu card builder is card JSON 1.0 — usually its multilingual share form (`i18n_elements`/`i18n_header`). The settings validator accepted only the canonical single-locale 1.0 shape, so a tenant's builder paste failed validation and silently killed the transport edge (the `installSection` throw happens before `onChange` starts it). The reserved 2.0 projector also dropped `margin`/`horizontal_spacing`, which 1.0 `column_set` and `column` carry natively — a real tenant export proved both keys legal.

## Decision

Every local card renders and sends as canonical card JSON 1.0: top-level `config`, optional `header`, non-empty `elements`, and an `alt` object on every `img`. Configuration accepts two input dialects resolved by `resolveCardFormat` over the closed `CardInputFormat` union: `'v1'` (canonical 1.0) and `'v1-builder-i18n'` (the builder's multilingual export). At render, `normalizeTemplateCard` collapses a builder export by lifting the `cardLocale` settings key (default `zh_cn`) to `elements`/`header`; card JSON 2.0 documents fail by name at settings validation. `convertCardV2toV1` stays exported as the reserved projector for a future `'v2'` dialect: adding that dialect is one union case plus one normalize branch, and its key set now keeps `margin`/`horizontal_spacing`.

## Consequences

Tenants paste builder exports directly. A wrong dialect or a missing locale fails loudly at settings validation, naming the entry and the locale, before any turn renders. Multilingual rendering is deferred: one configured locale per deployment, with viewer-locale rendering joining the future 2.0 work. The settings validator delegates card-shape authority to `resolveCardFormat`, so validation and rendering cannot drift apart.

## Related decisions

The [card templates note](2026-09-11-feishu-card-templates.md) owns the registry and variable pipeline; this note supersedes its 2.0-export framing of local cards.
