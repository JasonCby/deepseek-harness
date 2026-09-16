# Agent Note: Feishu interactive cards and chat session reset

Status: implemented

English | [中文](2026-09-16-feishu-interactive-cards-and-session-reset.zh.md)

## Problem

The Feishu front door could send text and uploaded files and nothing else, so a turn whose useful output is a rendered structure — a status board, a metrics table, a short report — had to describe it in prose or hand over a file. Separately, one chat mapped to one never-ending Session ([the Feishu bot Agent Note](../architecture/2026-09-08-feishu-bot-plugin.md)), so a user who changed topic carried every earlier turn into the new topic's prompts. The Web UI can open a fresh session for the same workspace, but a chat user has no equivalent: deleting the persisted log is the only way to start over, and it destroys history the Web UI can still open.

## Decision

`feishu_deliver` carries interactive cards beside files, and three chat commands move one chat to a new session generation. Both act on the durable session log and the active transport edge, so neither adds a service, a package, or an agent-loop extension point.

### Interactive cards

The tool takes an optional `cards` array next to `paths`, and `paths` is no longer required, so a turn may declare cards alone, files alone, or both. A card is accepted when it is a plain object whose `elements` property is an array; everything else about Feishu's card schema stays Feishu's to judge, because the tool's job is to reject model output that cannot be a card at all rather than to re-implement a third-party schema. Settlement reads the durable `tool/call` arguments, keeps declaration order, and drops exact duplicates by their serialized JSON. The router sends the cards of a settled turn before its files, each as one `msg_type: 'interactive'` reply through the active edge's API client, and one card failing is logged without stopping the remaining cards or files. The per-turn ceiling of 20 applies to cards and to files separately.

### Chat session reset

An admitted message whose trimmed text is exactly `/new`, `/reset`, or `/新会话` never reaches the agent. `ConversationRouter` retires the chat's routing handle, increments the chat's generation, persists the generations, and replies with the fixed notice `已开启新会话，此前的对话上下文已清空。`. The retired agent keeps running and its persisted session stays on disk, so it remains listed and openable in the Web UI; only the chat's routing pointer moves on. The next ordinary message hashes to a fresh Session id and creates or resumes that session.

Generations persist in `feishu-router-state.json` under `$DSH_HOME` (default `~/.dsh`). The router loads the file once on first use, accepts only positive integers, and replaces it atomically through a temporary file and `rename`, so neither a crash nor a half-written file can lose or corrupt a reset. A failed write is logged and leaves the in-memory generation in force.

### Session identity

`sessionIdForChat(chatId, epoch = 0)` hashes `${chatId}#${epoch}` instead of `chatId`, so the deterministic mapping that lets a restart recover a chat with no side-car state also separates that chat's generations.

## Alternatives considered

**A card content block in the prompt or session log.** Rejected: a model-visible content type would touch the LLM runtime and every provider for a presentation that one transport renders, while `feishu_deliver` already keeps model-declared artifacts in the durable log.

**Deleting or archiving the persisted session on reset.** Rejected: the Web UI keeps sessions openable and the log is the durable record of what the user paid for; starting a new topic must not destroy history the user did not ask to lose.

**A random per-generation id with a side-car map.** Rejected: the deterministic hash keeps recovery a `sessionPersistence.list()` membership check, and the generation file then records only a counter instead of a second identity space that can disagree with the log.

**Compaction, or a "forget the conversation" prompt, as the reset.** Rejected: context stays in the log and its token cost returns with the replayed prefix, and the effect would depend on model behavior.

**A model-invoked reset tool.** Rejected: a user-typed command acts deterministically and immediately, whereas routing it through the agent spends a model turn on a context reset and lets the model decline it.

## Consequences

- The Session id of every chat changes, because `sha256(chatId#0)` differs from the former `sha256(chatId)`. An existing chat does not resume its prior session after this change; that log stays on disk and openable, and the chat continues in a new generation.
- Delivery order per settled turn is text reply, cards, files.
- A call that declares nothing is schema-valid, so an empty delivery answers with a zero-count queue; the tool result reports file and card counts separately, which is what lets the model see that it declared nothing.
- Card validity beyond the `elements` array is Feishu's to enforce: such a card fails at the API, is logged, and is skipped while the rest of the delivery proceeds.
- Generation state lives outside the session log, so `$DSH_HOME` must be writable and persistent for resets to survive a restart; a lost file rolls a chat back to generation 0 and resumes the oldest persisted session for that chat.
- A retired agent is left registered rather than disposed, so a reset keeps one idle agent and its session resident until the registry disposes it.

## Testing

`packages/feishu/feishu/tests/T01-conversation-router.spec.ts` pins the card-before-file order, the rejection of payloads without an `elements` array, and the reset command's session move with an isolated `DSH_HOME`; `packages/feishu/feishu/tests/T02-transport-edges.spec.ts` pins the card sender's wiring into both transport edges.
