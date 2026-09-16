/** Turn settlement: extract the reply text and declared deliverables a completed turn leaves in the session log. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DELIVER_TOOL_NAME } from './deliver.ts'

/**
 * Collect the assistant text appended at or after one log position. The
 * session log is the durable source of truth: the reply a Feishu chat receives
 * is exactly what the log recorded, in order. Tool-only assistant messages
 * contribute nothing.
 * @param events - the session's ordered event log.
 * @param fromSeq - the log position just before the triggering prompt was admitted.
 * @returns the joined reply text, or undefined when the turn produced no assistant text.
 */
export function extractReplyText(events: readonly SessionEvent[], fromSeq: number): string | undefined {
  const parts: string[] = []
  for (const event of events) {
    if (event.seq < fromSeq || event.type !== 'assistant/message') continue
    const text = event.data.message.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('')
    if (text.trim() !== '') parts.push(text)
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

/** A card payload must be a plain object carrying Feishu's elements array. */
function isCardPayload(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Array.isArray((value as Record<string, unknown>).elements)
}

/**
 * Parse the durable arguments of one deliver-tool call.
 * @param event - the session log event.
 * @returns the parsed arguments object, or undefined when unparseable.
 */
function parseDeliverArguments(event: SessionEvent): Record<string, unknown> | undefined {
  if (event.type !== 'tool/call' || event.data.name !== DELIVER_TOOL_NAME) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(event.data.arguments)
  } catch {
    // Tool arguments are the loop's serialized JSON; an unparseable entry cannot carry deliverables.
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

/**
 * Collect the deliverable paths the turn declared through the deliver tool.
 * The durable `tool/call` arguments are the source of truth; validation ran at
 * call time, so a path the turn queued is delivered even if its file changed
 * since (the upload fails loud if it vanished).
 * @param events - the session's ordered event log.
 * @param fromSeq - the log position just before the triggering prompt was admitted.
 * @returns the declared paths, deduplicated, in declaration order.
 */
export function extractDeliverables(events: readonly SessionEvent[], fromSeq: number): string[] {
  const paths: string[] = []
  for (const event of events) {
    if (event.seq < fromSeq || event.type !== 'tool/call') continue
    if (event.data.name !== DELIVER_TOOL_NAME) continue
    const parsed = parseDeliverArguments(event)
    if (parsed === undefined) continue
    const declared: unknown = parsed.paths
    if (!Array.isArray(declared)) continue
    for (const path of declared) {
      if (typeof path === 'string' && path !== '') paths.push(path)
    }
  }
  return [...new Set(paths)]
}

/**
 * Collect the interactive cards the turn declared through the deliver tool,
 * in declaration order with exact-duplicate payloads removed.
 * @param events - the session's ordered event log.
 * @param fromSeq - the log position just before the triggering prompt was admitted.
 * @returns valid card payloads, in declaration order.
 */
export function extractCards(events: readonly SessionEvent[], fromSeq: number): Record<string, unknown>[] {
  const cards: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const event of events) {
    if (event.seq < fromSeq || event.type !== 'tool/call') continue
    if (event.data.name !== DELIVER_TOOL_NAME) continue
    const parsed = parseDeliverArguments(event)
    if (parsed === undefined) continue
    const declared: unknown = parsed.cards
    if (!Array.isArray(declared)) continue
    for (const card of declared) {
      if (!isCardPayload(card)) continue
      const fingerprint = JSON.stringify(card)
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      cards.push(card)
    }
  }
  return cards
}
