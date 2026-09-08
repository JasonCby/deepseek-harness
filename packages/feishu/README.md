---
description: "Package map for the Feishu (Lark) bot integration: chat events to multi-turn DSH sessions with replies sent back."
kind: "package-group"
---

# feishu/ — Feishu bot to DSH sessions

English | [中文](README.zh.md)

## Summary

The Feishu family connects a Feishu (Lark) bot to the harness: chat events arrive over an outbound WSS long connection or an inbound webhook route, each chat runs as one multi-turn root Session, and the assistant text each completed turn leaves in the session log is replied through the Feishu API.

## Packages

- [`feishu`](feishu/) — the bot plugin: ingress normalization, chat-to-Session routing, turn settlement, and the two transport edges.

## Related documentation

- [Feishu bot overlay example](../../apps/cli/config/examples/feishu-bot/cordis.yml)
- [Webhook runtime](../webhook/) — the fire-and-forget event family this plugin deliberately does not reuse
