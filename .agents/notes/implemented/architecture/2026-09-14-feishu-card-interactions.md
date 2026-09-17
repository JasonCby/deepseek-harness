# Agent Note: Feishu card interactions — callbacks answering approval and question waterfalls

Status: implemented

English | [中文](2026-09-14-feishu-card-interactions.zh.md)

## Problem

The Feishu channel could render structured replies (markdown cards, bound templates) but could not receive anything back: no card carried interactive components, no callback existed, and the approval path failed closed on Feishu-driven sessions because no `approval/request` answerer existed. The platform offers two card-callback delivery modes, chosen in the console beside the event subscription: long-connection delivery (card actions arrive as `card.action.trigger` event frames on the same websocket) and request-address delivery (HTTP posts). The card-entity update APIs (`im.v1.card.update`/`batchUpdate`) accept card JSON 2.0 only, while this package sends JSON 1.0.

## Decision

- **Callbacks follow the console's delivery config, and both ingress paths stay wired.** Long-connection mode delivers `card.action.trigger` as one more event frame: the websocket edge registers it on the dispatcher, and the handler's return value is relayed to the platform as the callback response (the SDK's `handleEventData` base64-wraps the invoke result and sends it back). Request-address mode posts to a dedicated exact route at `<path>/card` through the SDK's `CardActionHandler`, independent of the message transport. The two paths share one dispatch step; without a composed WebServer only the long-connection mode is served, and the skip is logged.
- **The callback response refreshes the card in place.** Feishu updates a clicked card when the callback response carries `{ card: { type: 'raw', data } }` (or a `template` directive), provided the card structure version matches — 1.0 in, 1.0 out. This replaces the 2.0-only update APIs entirely; `dispatch` is synchronous so the response lands well inside the platform's three-second window, and the agent's continued turn runs asynchronously.
- **Claim precedence is prepended.** The host-level remote-event forwarder registers at boot and claims every request it sees, delegating only when its client gives up; a normally registered channel answerer would never run, and with no client connected the request would hang forever. The answerers therefore register with `prepend: true`: the anchored claim comes first, and unanchored turns still pass through to the forwarder.
- **Answerers mount per agent and claim only anchored turns.** `InteractionBridge.mountAnswerers` registers `approval/request` and `user-questions/request` listeners on each chat agent's scoped context (setup callbacks for created/resumed agents, the agent's own ctx for adopted ones), so teardown drops the claim path with the scope. A listener consults the anchor the `ConversationRouter` records for the session's live turn; no anchor means the turn belongs to another channel and the listener delegates through `next()`, leaving the Web UI answering its own sessions. Undeliverable cards and disabled sections delegate the same way.
- **Templates style the frame; the builder owns the interactive components.** A configured `pendingCard`/`settledCard` is a local card JSON 1.0 frame with `{{toolName}}`/`{{reason}}` (pending) or `{{outcome}}`/`{{decidedBy}}`/`{{summary}}` (settled) placeholders; the builder interpolates, appends the button row (values carrying the branded interaction identity) or generates the form body — options project to `select_static`/`multi_select_static`, option-less questions to `input` inside one `form`, the submit button's value carrying the identity. A settled style may instead name a platform `settledTemplateId`.
- **Callbacks are wire-validated then matched.** `parseCardAction` reads the flattened form the SDK handler delivers (`action`/`operator` at the top level after header/event merge) and admits identity, verdict, form values, and operator. Unknown or malformed interactions still answer successfully — a stale toast rather than an error — so the platform never retries a click nothing pending can match. An aborted request (its signal) settles cancelled; the late click then meets the stale toast because there is no callback-free refresh path.

## Alternatives considered

**One ingress only.** Serving only the long-connection mode would strand request-address deployments (and webhook-transport setups wanting a separate callback URL); serving only the HTTP route would force a public listener on local long-connection setups. Wiring both paths behind one dispatch step costs one dispatcher registration.

**Use the card-entity update APIs for refreshes.** They require card JSON 2.0 end to end; converting the whole reply path to 2.0 to refresh one card family inverts the dependency. The callback-response refresh covers the interactive path (every refresh follows a click) without any update API. The residual gap — refreshing a card whose request aborted with no click — is accepted as a documented limitation.

**Answer every approval the bridge can see.** The waterfall is scope-filtered to the agent, but the same session can be driven from the Web UI; claiming those requests would race the Web UI's own panel. The anchor (set only for turns this router is serving) makes claiming structurally tied to channel ownership instead of heuristic.

## Consequences

`ask_user_question` becomes answerable from Feishu (options as selects, free text as inputs; the answer protocol's `custom` slot only carries option-less answers for now). The permission-ask path that previously failed closed on chat sessions now resolves through confirm cards when the preset policy asks. Style overrides reuse the template pipeline's dialect rules (`resolveCardFormat`, builder-i18n lifting), and `interpolateCard` became a shared export. Tests cover the builders, wire validation, both waterfalls' claim/delegate/abort paths, both ingress paths on a fake SDK (dispatcher registration and route HTTP discipline), and one real-Loader composition round trip through the real `CardActionHandler`.

## Related decisions

Card replies and templates are recorded in [the card-replies note](2026-09-10-feishu-card-replies.md) and [the templates note](2026-09-11-feishu-card-templates.md). The approval waterfall's contract lives in `dsh-user-approval`; the question schema in `dsh-user-questions`. Long-running approvals that must survive restarts are deliberately out of scope here — they need durable pending state and follow-up continuation, planned as their own capability seam.
