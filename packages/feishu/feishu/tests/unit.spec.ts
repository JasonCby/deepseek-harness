/** Pure-function unit tests: ingress normalization, dedup, framing, settlement, config validation. */

import type { ReadStream } from 'node:fs'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MessageDedup } from '../src/dedup.ts'
import { assertConfig, assertSettings, credentialRefsOf, type FeishuSettings } from '../src/config.ts'
import { DELIVER_TOOL_NAME, apply as applyDeliverTool } from '../src/deliver.ts'
import { normalizeEventData } from '../src/ingress.ts'
import { frameChatPrompt, stripMentionPlaceholders } from '../src/prompt.ts'
import { createFileReplySender, truncateReply } from '../src/reply.ts'
import { extractDeliverables, extractReplyText } from '../src/settlement.ts'
import { sessionIdForChat } from '../src/conversation.ts'
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
      replyCharLimit: 4000,
      failureNotice: 'failed',
      dedupCapacity: 1024,
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
})
