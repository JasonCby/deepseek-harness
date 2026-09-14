/** Pure-function unit tests: ingress normalization, dedup, framing, settlement, config validation. */

import type { ReadStream } from 'node:fs'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageDedup } from '../src/dedup.ts'
import { renderMarkdownCard } from '../src/card.ts'
import { assertConfig, assertSettings, credentialRefsOf, type FeishuSettings } from '../src/config.ts'
import { DELIVER_TOOL_NAME, apply as applyDeliverTool } from '../src/deliver.ts'
import { normalizeEventData } from '../src/ingress.ts'
import { frameChatPrompt, stripMentionPlaceholders } from '../src/prompt.ts'
import { createFileReplySender, truncateReply } from '../src/reply.ts'
import { createReactionSender } from '../src/reaction.ts'
import { createTopicOpener, topicSummary } from '../src/topic.ts'
import { convertCardV2toV1, matchCardTemplate, normalizeTemplateCard, renderTemplateReply, resolveCardFormat, resolveTemplateVariables, type CardTemplateEntry } from '../src/template.ts'
import type { LarkApiClient } from '../src/lark.ts'
import { extractDeliverables, extractReplyText, resolveReplyForm } from '../src/settlement.ts'
import { sessionIdForChat, sessionIdForThread } from '../src/conversation.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Tool definitions the deliver tool registered on a capture context. */
let registeredTools: { name: string; execute: (args: { paths: string[] }, exec: unknown) => Promise<unknown> }[] = []

/** One context whose tools.register captures definitions. */
function toolCaptureContext(): { tools: { register(definition: never): void } } {
  registeredTools = []
  return { tools: { register: (definition: never) => { registeredTools.push(definition) } } }
}

/** The single registered deliver tool definition. */
function deliverTool() {
  const tool = registeredTools.find(tool => tool.name === DELIVER_TOOL_NAME)
  expect(tool).toBeDefined()
  return tool!
}

/** Root for deliver-tool validation fixtures. */
let fixtureRoot: string | undefined

afterEach(async () => {
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = undefined
})

/** One flattened `im.message.receive_v1` dispatcher payload. */
function messagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
    },
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
    ...overrides,
  }
}

describe('normalizeEventData', () => {
  it('carries the topic identity when the event has one', () => {
    const base = messagePayload()
    const message = base.message as Record<string, unknown>
    const withTopic = normalizeEventData({ ...base, message: { ...message, thread_id: 'omt_1' } })
    expect(withTopic?.threadId).toBe('omt_1')
    expect(normalizeEventData(base)?.threadId).toBeUndefined()
  })

  it('normalizes one text message', () => {
    expect(normalizeEventData(messagePayload())).toEqual({
      messageId: 'om_1',
      chatId: 'oc_1',
      chatType: 'p2p',
      senderOpenId: 'ou_1',
      text: 'hello',
      attachments: [],
      mentioned: false,
    })
  })

  it('strips mention placeholders and records mentions', () => {
    const payload = messagePayload({
      message: {
        message_id: 'om_2',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 please review' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      },
    })
    expect(normalizeEventData(payload)).toMatchObject({ text: 'please review', mentioned: true, chatType: 'group' })
  })

  it('normalizes image and file messages into attachments', () => {
    expect(normalizeEventData(messagePayload({
      message: {
        message_id: 'om_img',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_abc' }),
      },
    }))).toMatchObject({ text: '', attachments: [{ kind: 'image', key: 'img_v3_abc' }] })
    expect(normalizeEventData(messagePayload({
      message: {
        message_id: 'om_file',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'file',
        content: JSON.stringify({ file_key: 'file_v3_xyz', file_name: 'report.pdf' }),
      },
    }))).toMatchObject({ text: '', attachments: [{ kind: 'file', key: 'file_v3_xyz', name: 'report.pdf' }] })
  })

  it('drops app-senders, unsupported types, keyless media, and malformed shapes', () => {
    expect(normalizeEventData(messagePayload({ sender: { sender_type: 'app' } }))).toBeUndefined()
    expect(normalizeEventData(messagePayload({
      message: { message_id: 'om_3', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'audio', content: '{}' },
    }))).toBeUndefined()
    expect(normalizeEventData(messagePayload({
      message: { message_id: 'om_5', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'image', content: '{}' },
    }))).toBeUndefined()
    expect(normalizeEventData(messagePayload({
      message: { message_id: 'om_6', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'file', content: '{"file_name":"a"}' },
    }))).toBeUndefined()
    expect(normalizeEventData('not an object')).toBeUndefined()
    expect(normalizeEventData(null)).toBeUndefined()
    expect(normalizeEventData({ message: { chat_id: 'oc_1' } })).toBeUndefined()
    expect(normalizeEventData(messagePayload({
      message: {
        message_id: 'om_4',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: 'not json',
      },
    }))).toBeUndefined()
  })
})

describe('MessageDedup', () => {
  it('claims each identity once', () => {
    const dedup = new MessageDedup(4)
    expect(dedup.claim('a')).toBe(true)
    expect(dedup.claim('a')).toBe(false)
    expect(dedup.claim('b')).toBe(true)
  })

  it('evicts the oldest identity beyond capacity', () => {
    const dedup = new MessageDedup(2)
    dedup.claim('a')
    dedup.claim('b')
    dedup.claim('c')
    expect(dedup.claim('a')).toBe(true)
    expect(dedup.claim('c')).toBe(false)
  })
})

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

describe('extractDeliverables', () => {
  /** Build one tool/call event. */
  function toolCallEvent(seq: number, name: string, args: string): SessionEvent {
    return {
      type: 'tool/call',
      seq,
      time: 0,
      data: { turn: 0, step: 0, callId: `c${String(seq)}`, name, arguments: args },
    } as SessionEvent
  }

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

describe('feishu_deliver tool', () => {
  it('registers under its declared name', () => {
    applyDeliverTool(toolCaptureContext() as never)
    expect(deliverTool().name).toBe(DELIVER_TOOL_NAME)
  })

  it('accepts deliverable files and rejects missing, empty, oversized, and non-file paths', async () => {
    applyDeliverTool(toolCaptureContext() as never)
    fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-feishu-deliver-'))
    const good = join(fixtureRoot, 'report.md')
    const empty = join(fixtureRoot, 'empty.txt')
    const huge = join(fixtureRoot, 'huge.bin')
    const missing = join(fixtureRoot, 'missing.pdf')
    await writeFile(good, 'deliverable')
    await writeFile(empty, '')
    await writeFile(huge, 'x')
    await truncate(huge, 30 * 1024 * 1024 + 1)
    const result = await deliverTool().execute({ paths: [good, empty, huge, missing, fixtureRoot] }, undefined) as {
      accepted: { path: string; name: string; bytes: number }[]
      rejected: { path: string; reason: string }[]
    }
    expect(result.accepted).toEqual([{ path: good, name: 'report.md', bytes: 11 }])
    expect(result.rejected.map(entry => entry.path)).toEqual([empty, huge, missing, fixtureRoot])
    expect(result.rejected[0]?.reason).toContain('empty')
    expect(result.rejected[1]?.reason).toContain('30 MB')
  })
})

describe('createFileReplySender', () => {
  it('uploads once and replies with the returned file key', async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-feishu-filereply-'))
    const deliverable = join(fixtureRoot, 'report.md')
    await writeFile(deliverable, 'deliverable')
    const uploads: { name: string }[] = []
    const replies: { messageId: string; msgType: string; content: string }[] = []
    const client = {
      im: {
        v1: {
          message: {
            reply: async (params: { path: { message_id: string }; data: { msg_type: string; content: string } }) => {
              replies.push({ messageId: params.path.message_id, msgType: params.data.msg_type, content: params.data.content })
              return { code: 0 }
            },
          },
          file: {
            create: async (payload: { data: { file_name: string; file: ReadStream } }) => {
              uploads.push({ name: payload.data.file_name })
              // The fake consumes nothing; destroy the stream so no fd leaks.
              payload.data.file.destroy()
              return { file_key: 'fk_new' }
            },
          },
        },
      },
    }
    await createFileReplySender(client as never)('om_1', { name: 'report.md', path: deliverable })
    expect(uploads).toEqual([{ name: 'report.md' }])
    expect(replies).toEqual([{ messageId: 'om_1', msgType: 'file', content: JSON.stringify({ file_key: 'fk_new' }) }])
  })

  it('throws when the upload returns no key', async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-feishu-filereply-'))
    const deliverable = join(fixtureRoot, 'x.bin')
    await writeFile(deliverable, 'x')
    const client = {
      im: {
        v1: {
          message: { reply: async () => ({ code: 0 }) },
          file: {
            create: async (payload: { data: { file: ReadStream } }) => {
              payload.data.file.destroy()
              return null
            },
          },
        },
      },
    }
    await expect(
      createFileReplySender(client as never)('om_1', { name: 'x', path: deliverable }),
    ).rejects.toThrow(/no file_key/)
  })
})

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

describe('truncateReply', () => {
  it('keeps short text and truncates long text', () => {
    expect(truncateReply('short', 10)).toBe('short')
    const truncated = truncateReply('a'.repeat(20), 10)
    expect(truncated.length).toBe(10)
    expect(truncated.endsWith('…')).toBe(true)
  })
})

describe('extractReplyText', () => {
  /** Build one assistant/message event. */
  function assistantEvent(seq: number, text: string): SessionEvent {
    return {
      type: 'assistant/message',
      seq,
      time: 0,
      data: { turn: 0, step: 0, message: { content: [{ type: 'text', text }] } },
    } as SessionEvent
  }

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

describe('sessionIdForChat', () => {
  it('is deterministic per chat and distinct across chats', () => {
    expect(sessionIdForChat('oc_1')).toBe(sessionIdForChat('oc_1'))
    expect(sessionIdForChat('oc_1')).not.toBe(sessionIdForChat('oc_2'))
    expect(sessionIdForChat('oc_1').startsWith('feishu-')).toBe(true)
  })
})

describe('settings validation', () => {
  /** One minimal valid settings section. */
  function base(): FeishuSettings {
    return {
      transport: 'websocket',
      domain: 'feishu',
      appIdEnv: 'DSH_FEISHU_APP_ID',
      appSecretEnv: 'DSH_FEISHU_APP_SECRET',
      verificationTokenEnv: 'DSH_FEISHU_VERIFICATION_TOKEN',
      encryptKeyEnv: 'DSH_FEISHU_ENCRYPT_KEY',
      path: '/feishu',
      maxBodyBytes: 65536,
      allowChatIds: [],
      groupRequireMention: true,
      replyInThread: false,
      replyCharLimit: 4000,
      replyForm: 'text',
      cardTitle: 'DSH',
      cardLocale: 'zh_cn',
      thinkingEmoji: 'Typing',
      failureNotice: 'failed',
      dedupCapacity: 1024,
      cardTemplates: [],
    }
  }

  it('accepts the base section', () => {
    expect(() => {
      assertSettings(base())
    }).not.toThrow()
  })

  it('accepts domain shorthands and self-hosted origins, rejecting the rest', () => {
    expect(() => { assertSettings({ ...base(), domain: 'lark' }) }).not.toThrow()
    expect(() => { assertSettings({ ...base(), domain: 'https://open.internal.example.com' }) }).not.toThrow()
    expect(() => { assertSettings({ ...base(), domain: 'internal' }) }).toThrow(/domain/)
    expect(() => { assertSettings({ ...base(), domain: 'https://open.internal.example.com/' }) }).toThrow(/domain/)
    expect(() => { assertSettings({ ...base(), domain: ' https://open.internal.example.com' }) }).toThrow(/domain/)
  })

  it('rejects malformed paths, empty notices, and dirty allowlists', () => {
    expect(() => {
      assertSettings({ ...base(), path: 'feishu' })
    }).toThrow(/path/)
    expect(() => {
      assertSettings({ ...base(), path: '/' })
    }).toThrow(/path/)
    expect(() => {
      assertSettings({ ...base(), failureNotice: ' ' })
    }).toThrow(/failureNotice/)
    expect(() => {
      assertSettings({ ...base(), allowChatIds: [' x'] })
    }).toThrow(/allowChatIds/)
    expect(() => {
      assertSettings({ ...base(), cardTitle: ' ' })
    }).toThrow(/cardTitle/)
    expect(() => {
      assertSettings({ ...base(), thinkingEmoji: ' Typing' })
    }).toThrow(/thinkingEmoji/)
  })

  it('lists every credential reference the section consumes', () => {
    const refs = credentialRefsOf({ ...base(), appSecretEnv: 'FEISHU_SECRET' })
    expect(refs).toEqual([
      'DSH_FEISHU_APP_ID',
      'FEISHU_SECRET',
      'DSH_FEISHU_VERIFICATION_TOKEN',
      'DSH_FEISHU_ENCRYPT_KEY',
    ])
  })

  it('rejects an empty workspace path in the composition config', () => {
    expect(() => {
      assertConfig({ ...base(), workspacePath: ' ', agentPreset: 'standard', permissionPreset: 'read-only' })
    }).toThrow(/workspacePath/)
  })

  it('rejects malformed card template entries', () => {
    const entry: CardTemplateEntry = {
      name: 'alarm',
      bindTool: 'workflow',
      templateId: 'AAq1',
      variables: { who: { from: 'context', key: 'senderOpenId' } },
    }
    const withTemplates = (cardTemplates: CardTemplateEntry[]): FeishuSettings => ({ ...base(), cardTemplates })
    expect(() => { assertSettings(withTemplates([entry, { ...entry }])) }).toThrow(/names/)
    expect(() => { assertSettings(withTemplates([{ ...entry, card: { elements: [{ tag: 'hr' }] } }])) }).toThrow(/exactly one/)
    const { templateId: _platform, ...neither } = entry
    const local = { ...neither, card: { elements: [{ tag: 'markdown', content: '{{who}}' }] } }
    expect(() => { assertSettings(withTemplates([neither])) }).toThrow(/exactly one/)
    expect(() => { assertSettings(withTemplates([{ ...neither, card: { elements: [] } }])) }).toThrow(/elements array/)
    expect(() => { assertSettings(withTemplates([{ ...local, variables: { a: { from: 'context', key: 'nope' } } }])) }).toThrow(/context key/)
    expect(() => { assertSettings(withTemplates([{ ...local, variables: { a: { from: 'tool-result' } } }])) }).toThrow(/tool-result path/)
    expect(() => { assertSettings(withTemplates([local])) }).not.toThrow()
    expect(() => { assertSettings(withTemplates([{ ...local, card: { schema: '2.0', body: { elements: [{ tag: 'hr' }] } } }])) }).toThrow(/card JSON 2\.0/)
    expect(() => { assertSettings(withTemplates([{ ...neither, card: { i18n_elements: { en_us: [{ tag: 'hr' }] } } }])) }).toThrow(/"zh_cn" elements array/)
    expect(() => { assertSettings(withTemplates([{ ...neither, card: builderExport }])) }).not.toThrow()
    expect(() => { assertSettings({ ...base(), cardLocale: ' ' }) }).toThrow(/cardLocale/)
  })
})
