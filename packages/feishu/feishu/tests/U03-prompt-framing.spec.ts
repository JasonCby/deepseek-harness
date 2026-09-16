/** U03: chat prompt framing — untrusted-input provenance, mention stripping, attachment listing. */

import { frameChatPrompt, stripMentionPlaceholders } from '../src/prompt.ts'
import { describe, expect, it } from 'vitest'

describe('prompt framing', () => {
  it('strips mention placeholders', () => {
    expect(stripMentionPlaceholders(' @_user_1  hi @_user_2 ')).toBe('hi')
  })

  it('frames untrusted input with provenance', () => {
    const prompt = frameChatPrompt({
      messageId: 'om_1',
      chatId: 'oc_1',
      chatType: 'p2p',
      senderOpenId: 'ou_1',
      text: 'run the tests',
      attachments: [],
      mentioned: false,
    })
    expect(prompt).toContain('untrusted external input')
    expect(prompt).toContain('oc_1')
    expect(prompt).toContain('ou_1')
    expect(prompt.endsWith('run the tests')).toBe(true)
  })

  it('lists attachment names and stands in for empty text', () => {
    const prompt = frameChatPrompt({
      messageId: 'om_f1',
      chatId: 'oc_1',
      chatType: 'p2p',
      text: '',
      attachments: [
        { kind: 'file', key: 'file_v3_a', name: 'report.pdf' },
        { kind: 'image', key: 'img_v3_b' },
      ],
      mentioned: false,
    })
    expect(prompt).toContain('(no text; this message carries only attachments)')
    expect(prompt).toContain('Attachments: report.pdf, img_v3_b')
  })
})
