/** C04: turn settlement extraction — reply text and deliverable declarations from the session log. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DELIVER_TOOL_NAME } from '../src/deliver.ts'
import { extractDeliverables, extractReplyText } from '../src/settlement.ts'
import { describe, expect, it } from 'vitest'

/** Build one tool/call event. */
function toolCallEvent(seq: number, name: string, args: string): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: 0,
    data: { turn: 0, step: 0, callId: `c${String(seq)}`, name, arguments: args },
  } as SessionEvent
}

/** Build one assistant/message event. */
function assistantEvent(seq: number, text: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    data: { turn: 0, step: 0, message: { content: [{ type: 'text', text }] } },
  } as SessionEvent
}

describe('extractDeliverables', () => {
  it('collects deliver-tool declarations at or after the boundary, deduplicated', () => {
    const events = [
      toolCallEvent(0, DELIVER_TOOL_NAME, JSON.stringify({ paths: ['/tmp/old.pdf'] })),
      toolCallEvent(1, DELIVER_TOOL_NAME, JSON.stringify({ paths: ['/tmp/a.pdf', '/tmp/b.csv'] })),
      toolCallEvent(2, 'bash', '{"command":"ls"}'),
      toolCallEvent(3, DELIVER_TOOL_NAME, JSON.stringify({ paths: ['/tmp/a.pdf', ''] })),
      toolCallEvent(4, DELIVER_TOOL_NAME, 'not json'),
      toolCallEvent(5, DELIVER_TOOL_NAME, JSON.stringify({ nope: true })),
    ]
    expect(extractDeliverables(events, 1)).toEqual(['/tmp/a.pdf', '/tmp/b.csv'])
    expect(extractDeliverables(events, 4)).toEqual([])
  })
})

describe('extractReplyText', () => {
  it('collects assistant text at or after the boundary, skipping tool turns', () => {
    const events = [
      assistantEvent(0, 'before'),
      assistantEvent(1, 'first part'),
      { type: 'tool/result', seq: 2, time: 0, data: {} } as SessionEvent,
      assistantEvent(3, 'second part'),
    ]
    expect(extractReplyText(events, 1)).toBe('first part\n\nsecond part')
    expect(extractReplyText(events, 4)).toBeUndefined()
  })
})
