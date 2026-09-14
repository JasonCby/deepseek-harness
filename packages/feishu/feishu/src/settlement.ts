/** Turn settlement: extract the reply text and declared deliverables a completed turn leaves in the session log. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReplyForm, ResolvedReplyForm } from './types.ts'
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

/**
 * Resolve the configured reply form onto one settled turn. `text` and `card`
 * pass through unchanged; `auto` classifies the turn's log window — a window
 * carrying workflow runs or approval asks settles as a card, everything else
 * as plain text.
 * @param form - the configured reply form.
 * @param events - the session's ordered event log.
 * @param fromSeq - the log position just before the triggering prompt was admitted.
 * @returns the concrete form the settled reply takes.
 */
export function resolveReplyForm(form: ReplyForm, events: readonly SessionEvent[], fromSeq: number): ResolvedReplyForm {
  if (form === 'card') return 'card'
  if (form === 'text') return 'text'
  for (const event of events) {
    if (event.seq < fromSeq) continue
    // The tool-workflow family is merge-extensible, so the prefix carries future
    // members; approval/asked is one fixed audit event.
    if (event.type.startsWith('tool-workflow/') || event.type === 'approval/asked') return 'card'
  }
  return 'text'
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
    let parsed: unknown
    try {
      parsed = JSON.parse(event.data.arguments)
    } catch {
      // Tool arguments are the loop's serialized JSON; an unparseable entry cannot carry paths.
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const declared: unknown = (parsed as Record<string, unknown>)['paths']
    if (!Array.isArray(declared)) continue
    for (const path of declared) {
      if (typeof path === 'string' && path !== '') paths.push(path)
    }
  }
  return [...new Set(paths)]
}
