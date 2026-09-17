/** C13: card interactions — markdown cards, reply forms, reactions, topics, card templates, JSON 1.0 normalization. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { renderMarkdownCard } from '../src/card.ts'
import type { LarkApiClient } from '../src/lark.ts'
import { createReactionSender } from '../src/reaction.ts'
import { createTopicOpener, topicSummary } from '../src/topic.ts'
import {
  convertCardV2toV1,
  matchCardTemplate,
  normalizeTemplateCard,
  renderTemplateReply,
  resolveCardFormat,
  resolveTemplateVariables,
  type CardTemplateEntry,
} from '../src/template.ts'
import { resolveReplyForm } from '../src/settlement.ts'
import { sessionIdForChat, sessionIdForThread } from '../src/conversation.ts'

describe('renderMarkdownCard', () => {
  it('projects settled markdown under the configured title', () => {
    expect(renderMarkdownCard('done', 'Ops')).toEqual({
      header: { template: 'blue', title: { tag: 'plain_text', content: 'Ops' } },
      elements: [{ tag: 'markdown', content: 'done' }],
    })
  })
})

describe('resolveReplyForm', () => {
  /** Build one session event of the given type. */
  function event(seq: number, type: string): SessionEvent {
    return { type, seq, time: 0, data: {} } as SessionEvent
  }

  it('passes the explicit text and card settings through unchanged', () => {
    expect(resolveReplyForm('text', [event(0, 'tool-workflow/run-start')], 0)).toBe('text')
    expect(resolveReplyForm('card', [], 0)).toBe('card')
  })

  it('auto settles workflow and approval turns as cards', () => {
    expect(resolveReplyForm('auto', [event(0, 'assistant/message'), event(1, 'tool-workflow/run-start')], 0)).toBe('card')
    expect(resolveReplyForm('auto', [event(0, 'approval/asked')], 0)).toBe('card')
  })

  it('auto keeps unstructured turns as text and ignores the pre-turn window', () => {
    expect(resolveReplyForm('auto', [event(0, 'assistant/message'), event(1, 'tool/result')], 0)).toBe('text')
    expect(resolveReplyForm('auto', [event(0, 'tool-workflow/run-end')], 1)).toBe('text')
    expect(resolveReplyForm('auto', [], 0)).toBe('text')
  })
})

describe('createReactionSender', () => {
  /** Build one fake API client with per-call response codes. */
  function client(codes: { create?: number; remove?: number }): LarkApiClient {
    return {
      im: {
        v1: {
          message: { reply: async () => ({ code: 0 }) },
          messageReaction: {
            create: async () => ({ code: codes.create ?? 0, ...(codes.create ?? 0) === 0 ? { data: { reaction_id: 're_9' } } : { msg: 'refused' } }),
            delete: async () => ({ code: codes.remove ?? 0, ...(codes.remove ?? 0) === 0 ? {} : { msg: 'refused' } }),
          },
          messageResource: { get: async () => { throw new Error('unused') } },
          file: { create: async () => { throw new Error('unused') } },
        },
      },
    }
  }

  it('returns the reaction identity and removes it by identity', async () => {
    const sender = createReactionSender(client({}))
    await expect(sender.add('om_1', 'Typing')).resolves.toBe('re_9')
    await expect(sender.remove('om_1', 're_9')).resolves.toBeUndefined()
  })

  it('throws on Feishu refusals', async () => {
    await expect(createReactionSender(client({ create: 230001 })).add('om_1', 'Typing')).rejects.toThrow(/230001/)
    await expect(createReactionSender(client({ remove: 230002 })).remove('om_1', 're_9')).rejects.toThrow(/230002/)
  })
})

describe('sessionIdForThread', () => {
  it('is deterministic per topic, distinct from the main chat and other topics', () => {
    expect(sessionIdForThread('oc_1', 'omt_1')).toBe(sessionIdForThread('oc_1', 'omt_1'))
    expect(sessionIdForThread('oc_1', 'omt_1')).not.toBe(sessionIdForChat('oc_1'))
    expect(sessionIdForThread('oc_1', 'omt_1')).not.toBe(sessionIdForThread('oc_1', 'omt_2'))
    expect(sessionIdForThread('oc_1', 'omt_1')).not.toBe(sessionIdForThread('oc_2', 'omt_1'))
    expect(sessionIdForThread('oc_1', 'omt_1').startsWith('feishu-')).toBe(true)
  })
})

describe('topicSummary', () => {
  it('single-lines and truncates to the summary bound', () => {
    expect(topicSummary('  hello \n  world  ')).toBe('hello world')
    expect(topicSummary('x'.repeat(100)).length).toBe(64)
    expect(topicSummary('x'.repeat(100)).endsWith('…')).toBe(true)
  })
})

describe('createTopicOpener', () => {
  /** Build one fake API client whose reply returns the given envelope. */
  function client(envelope: { code?: number; msg?: string; data?: { message_id?: string; thread_id?: string } }): LarkApiClient {
    return {
      im: {
        v1: {
          message: { reply: async () => envelope },
          messageReaction: { create: async () => ({ code: 0 }), delete: async () => ({ code: 0 }) },
          messageResource: { get: async () => { throw new Error('unused') } },
          file: { create: async () => { throw new Error('unused') } },
        },
      },
    }
  }

  it('opens one topic and returns its identities', async () => {
    const opener = createTopicOpener(client({ code: 0, data: { message_id: 'om_lead', thread_id: 'omt_1' } }))
    await expect(opener.open('om_1', 'summary')).resolves.toEqual({ leadMessageId: 'om_lead', threadId: 'omt_1' })
  })

  it('throws on refusals and on responses without a thread identity', async () => {
    await expect(createTopicOpener(client({ code: 230001, msg: 'refused' })).open('om_1', 's')).rejects.toThrow(/230001/)
    await expect(createTopicOpener(client({ code: 0, data: { message_id: 'om_lead' } })).open('om_1', 's')).rejects.toThrow(/thread identity/)
  })
})

describe('card templates', () => {
  /** Build one session event of the given type. */
  function event(seq: number, type: string, data: unknown = {}): SessionEvent {
    return { type, seq, time: 0, data } as SessionEvent
  }

  /** One turn window with a workflow call whose result carries meta. */
  function workflowTurn(meta: unknown): SessionEvent[] {
    return [
      event(0, 'tool/call', { turn: 0, step: 0, callId: 'c1', name: 'workflow', arguments: '{}' }),
      event(1, 'tool-workflow/run-start', { runId: 'r1', name: 'alarm-report' }),
      event(2, 'tool/result', {
        turn: 0, step: 0,
        message: { source: { kind: 'tool', callId: 'c1' }, content: [], role: 'user' },
        meta,
      }),
      event(3, 'assistant/message'),
    ]
  }

  const message = {
    messageId: 'om_1', chatId: 'oc_1', chatType: 'p2p', senderOpenId: 'ou_1', text: 'q', attachments: [], mentioned: false,
  }

  const entry: CardTemplateEntry = {
    name: 'alarm',
    bindTool: 'workflow',
    templateId: 'AAq1',
    variables: {
      who: { from: 'context', key: 'senderOpenId', required: true },
      reply: { from: 'tool-result', path: 'result.reply', required: true },
      note: { from: 'tool-result', path: 'result.note' },
    },
  }

  it('matches the first bound entry, honoring the workflow-name filter', () => {
    const events = workflowTurn({ runId: 'r1', name: 'alarm-report', result: { reply: 'done' } })
    expect(matchCardTemplate([entry], events, 0)?.name).toBe('alarm')
    expect(matchCardTemplate([{ ...entry, workflowName: 'other' }], events, 0)).toBeUndefined()
    expect(matchCardTemplate([entry], [event(0, 'assistant/message')], 0)).toBeUndefined()
  })

  it('resolves context facts and tool-result paths, omitting unresolvable optionals', () => {
    const resolved = resolveTemplateVariables(entry, workflowTurn({ runId: 'r1', name: 'alarm-report', result: { reply: 'done' } }), 0, message)
    expect(resolved).toEqual({ variables: { who: 'ou_1', reply: 'done' } })
  })

  it('fails on missing required variables and over-long values, coercing non-strings', () => {
    const missing = resolveTemplateVariables(entry, workflowTurn({ runId: 'r1', name: 'n', result: {} }), 0, message)
    expect('error' in missing && missing.error).toMatch(/"reply" is unresolvable/)
    const numeric = resolveTemplateVariables({ ...entry, variables: { count: { from: 'tool-result', path: 'result.count', required: true } } },
      workflowTurn({ result: { count: 7 } }), 0, message)
    expect(numeric).toEqual({ variables: { count: '7' } })
    const overLong = resolveTemplateVariables({ ...entry, variables: { reply: { from: 'tool-result', path: 'result.reply', required: true, maxLength: 2 } } },
      workflowTurn({ result: { reply: 'done' } }), 0, message)
    expect('error' in overLong && overLong.error).toMatch(/"reply" exceeds 2 characters/)
  })

  it('renders platform templates and interpolated local cards', () => {
    expect(renderTemplateReply(entry, { who: 'ou_1' })).toEqual({ kind: 'template', templateId: 'AAq1', variables: { who: 'ou_1' } })
    const local = renderTemplateReply({ name: 'alarm', bindTool: 'workflow', card: { elements: [{ tag: 'markdown', content: 'said {{who}} and {{missing}}' }] }, variables: {} }, { who: 'ou_1' })
    expect(local).toEqual({ kind: 'localCard', card: { elements: [{ tag: 'markdown', content: 'said ou_1 and ' }] } })
  })
})

/** The builder's multilingual export, reduced from a tenant sample. */
const builderExport = {
  config: { update_multi: true },
  i18n_elements: {
    zh_cn: [
      { tag: 'img', img_key: 'img_v3_02gm', scale_type: 'crop_center' },
      {
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: '8px',
        margin: '16px 0px 0px 0px',
        columns: [{ tag: 'column', width: 'weighted', weight: 1, background_style: 'grey', elements: [{ tag: 'markdown', content: '**订单金额**' }] }],
      },
    ],
  },
  i18n_header: {
    zh_cn: { title: { tag: 'plain_text', content: '恭喜{{who}}签约' }, template: 'red' },
  },
}

describe('card format resolution and normalization', () => {
  const label = 'feishu cardTemplates entry "alarm" card'

  it('accepts canonical card JSON 1.0 and only adds the img alt', () => {
    expect(resolveCardFormat({ elements: [{ tag: 'hr' }] }, 'zh_cn', label)).toBe('v1')
    expect(normalizeTemplateCard({ config: { update_multi: true }, elements: [{ tag: 'img', img_key: 'k' }] }, 'zh_cn', label)).toEqual({
      config: { update_multi: true },
      elements: [{ tag: 'img', img_key: 'k', alt: { tag: 'plain_text', content: '' } }],
    })
  })

  it('lifts the configured locale out of a builder multilingual export', () => {
    expect(resolveCardFormat(builderExport, 'zh_cn', label)).toBe('v1-builder-i18n')
    expect(normalizeTemplateCard(builderExport, 'zh_cn', label)).toEqual({
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: '恭喜{{who}}签约' }, template: 'red' },
      elements: [
        { tag: 'img', img_key: 'img_v3_02gm', scale_type: 'crop_center', alt: { tag: 'plain_text', content: '' } },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: '8px',
          margin: '16px 0px 0px 0px',
          columns: [{ tag: 'column', width: 'weighted', weight: 1, background_style: 'grey', elements: [{ tag: 'markdown', content: '**订单金额**' }] }],
        },
      ],
    })
  })

  it('fails loudly on card JSON 2.0, missing locales, and unrecognized shapes', () => {
    expect(() => resolveCardFormat({ schema: '2.0', body: { elements: [] } }, 'zh_cn', label)).toThrow(/card JSON 2\.0/)
    expect(() => resolveCardFormat({ body: { elements: [] } }, 'zh_cn', label)).toThrow(/card JSON 2\.0/)
    expect(() => resolveCardFormat(builderExport, 'en_us', label)).toThrow(/"en_us" elements array under i18n_elements/)
    expect(() => resolveCardFormat('text', 'zh_cn', label)).toThrow(/card JSON object/)
    expect(() => resolveCardFormat({ header: {} }, 'zh_cn', label)).toThrow(/elements array or an i18n_elements map/)
    expect(() => normalizeTemplateCard({ elements: [] }, 'zh_cn', label)).toThrow(/elements array/)
  })

  it('renders builder exports through the local-card path after normalization', () => {
    const rendered = renderTemplateReply({ name: 'alarm', bindTool: 'workflow', card: builderExport, variables: {} }, { who: 'ou_1' })
    expect(rendered.kind).toBe('localCard')
    if (rendered.kind !== 'localCard') return
    const card = rendered.card as Record<string, unknown>
    expect(card['i18n_elements']).toBeUndefined()
    expect(card['i18n_header']).toBeUndefined()
    expect(Array.isArray(card['elements'])).toBe(true)
    expect((card['header'] as Record<string, { content: string }>)['title']).toMatchObject({ content: '恭喜ou_1签约' })
  })
})

describe('convertCardV2toV1', () => {
  it('lifts body elements, drops 2.0-only keys, keeps 1.0 column spacing, and gives bare images an alt', () => {
    expect(convertCardV2toV1({
      schema: '2.0',
      header: { template: 'blue', title: { tag: 'plain_text', content: 'T' }, text_tag_list: [{ tag: 'text_tag', element_id: 'e1', color: 'red', text: { tag: 'plain_text', content: 'x' } }] },
      body: { elements: [
        { tag: 'markdown', content: 'a', element_id: 'm1', margin: '0px' },
        { tag: 'hr', element_id: 'h1' },
        { tag: 'img', img_key: 'k', fallback_img_key: 'f', corner_radius: '4px' },
        { tag: 'column_set', element_id: 'c1', margin: '16px', horizontal_spacing: '8px', columns: [{ tag: 'column', weight: 1 }] },
      ] },
    })).toEqual({
      header: { template: 'blue', title: { tag: 'plain_text', content: 'T' }, text_tag_list: [{ tag: 'text_tag', color: 'red', text: { tag: 'plain_text', content: 'x' } }] },
      elements: [
        { tag: 'markdown', content: 'a', margin: '0px' },
        { tag: 'hr' },
        { tag: 'img', img_key: 'k', alt: { tag: 'plain_text', content: '' } },
        { tag: 'column_set', margin: '16px', horizontal_spacing: '8px', columns: [{ tag: 'column', weight: 1 }] },
      ],
    })
  })

  it('passes non-object documents through', () => {
    expect(convertCardV2toV1('text')).toBe('text')
    expect(convertCardV2toV1([{ tag: 'hr', element_id: 'x' }])).toEqual([{ tag: 'hr' }])
  })
})
