/** Turn settlement: extract the reply text a completed turn leaves in the session log. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReplyForm, ResolvedReplyForm } from './types.ts'

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
