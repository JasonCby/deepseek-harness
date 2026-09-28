/** C10: ConversationRouter behavior tests over a real Cordis Context with stubbed core services. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionIdForChat } from '../src/conversation.ts'
import type { FeishuSettings } from '../src/config.ts'
import {
  buildHandle,
  disposes,
  externalAgents,
  fetchResourceMock,
  followups,
  isolateHome,
  message,
  mountedPlugins,
  mountedPresets,
  persistence,
  reply,
  replyCard,
  replyFile,
  resetC10,
  restoreHome,
  router,
  saveFileStream,
  servedHandles,
  settings,
  stubbedContext,
  whenIdleBehaviors,
  workspace,
} from './c10-stubs.ts'

let homeDir: string

beforeEach(() => {
  homeDir = isolateHome()
})

afterEach(() => {
  restoreHome(homeDir)
  resetC10()
})

describe('ConversationRouter', () => {
  it('creates one titled, permissioned session and replies with the turn text', async () => {
    const ctx = stubbedContext()
    const live = settings()
    const title = (ctx.get('sessionTitle') as unknown as { rename: ReturnType<typeof vi.fn> }).rename
    const presets = ctx.get('permissionPresets') as unknown as { set: ReturnType<typeof vi.fn> }
    router(ctx, live).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    const sessionId = sessionIdForChat('oc_1')
    expect(followups.get(sessionId)).toHaveBeenCalledOnce()
    const first = followups.get(sessionId)?.mock.calls[0]?.[0]
    expect(first?.content[0]?.text).toContain('untrusted external input')
    expect((first?.content[0]?.text ?? '').endsWith('hello')).toBe(true)
    expect(title).toHaveBeenCalledWith(expect.anything(), 'Feishu chat oc_1')
    expect(presets.set).toHaveBeenCalledWith(expect.anything(), 'read-only')
    expect(mountedPlugins).toContain('feishu-deliver-tool')
    expect(workspace.attachSession).toHaveBeenCalledWith(sessionId)
    expect(reply).toHaveBeenCalledWith('om_1', { kind: 'text', text: expect.stringMatching(/^answer /) as string })
  })

  it('reuses the live session across turns of one chat', async () => {
    const ctx = stubbedContext()
    const create = (ctx.get('agents') as unknown as { create: ReturnType<typeof vi.fn> }).create
    const subject = router(ctx, settings())
    subject.accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    subject.accept(message({ messageId: 'om_2' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    expect(create).toHaveBeenCalledOnce()
    expect(followups.get(sessionIdForChat('oc_1'))).toHaveBeenCalledTimes(2)
  })

  it('adopts a live agent another channel published instead of colliding on resume', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    servedHandles.set(sessionId, buildHandle(sessionId))
    const create = (ctx.get('agents') as unknown as { create: ReturnType<typeof vi.fn> }).create
    const resume = (ctx.get('agents') as unknown as { resume: ReturnType<typeof vi.fn> }).resume
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(create).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
    expect(followups.get(sessionId)).toHaveBeenCalledOnce()
    expect(reply).toHaveBeenCalledWith('om_1', { kind: 'text', text: expect.stringMatching(/^answer /) as string })
  })

  it('brackets one turn with the thinking reaction', async () => {
    const ctx = stubbedContext()
    const added: { messageId: string; emoji: string }[] = []
    const removed: { messageId: string; reactionId: string }[] = []
    const subject = router(ctx, settings())
    subject.setReactionSender({
      add: async (messageId, emoji) => {
        added.push({ messageId, emoji })
        return 're_1'
      },
      remove: async (messageId, reactionId) => {
        removed.push({ messageId, reactionId })
      },
    })
    subject.accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(added).toEqual([{ messageId: 'om_1', emoji: 'Typing' }])
    expect(removed).toEqual([{ messageId: 'om_1', reactionId: 're_1' }])
  })

  it('skips the thinking reaction when disabled and survives its failure', async () => {
    const disabledCtx = stubbedContext()
    let adds = 0
    const disabled = router(disabledCtx, { ...settings(), thinkingEmoji: '' })
    disabled.setReactionSender({
      add: async () => {
        adds += 1
        return 're_1'
      },
      remove: async () => {},
    })
    disabled.accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(adds).toBe(0)

    const failingCtx = stubbedContext()
    const failing = router(failingCtx, settings())
    failing.setReactionSender({
      add: async () => { throw new Error('reaction refused') },
      remove: async () => {},
    })
    failing.accept(message({ messageId: 'om_2' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    expect(reply.mock.calls[1]?.[1]?.kind).toBe('text')
  })

  it('drops retry deliveries of one message identity', async () => {
    const ctx = stubbedContext()
    const subject = router(ctx, settings())
    subject.accept(message())
    subject.accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(followups.get(sessionIdForChat('oc_1'))).toHaveBeenCalledOnce()
  })

  it('enforces the live allowlist and group mention gates', async () => {
    const ctx = stubbedContext()
    const live = { ...settings(), allowChatIds: ['oc_allowed'] }
    const subject = router(ctx, live)
    subject.accept(message({ chatId: 'oc_other' }))
    subject.accept(message({ messageId: 'om_g1', chatId: 'oc_allowed', chatType: 'group', mentioned: false, text: 'hi' }))
    subject.accept(message({ messageId: 'om_g2', chatId: 'oc_allowed', text: '' }))
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(reply).not.toHaveBeenCalled()
    expect(servedHandles.size).toBe(0)
    subject.accept(message({ messageId: 'om_g3', chatId: 'oc_allowed', chatType: 'group', mentioned: true, text: 'hi' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
  })

  it('answers with the failure notice when the turn fails', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async () => {
      throw new Error('turn exploded')
    })
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_1', { kind: 'text', text: 'processing failed' }) })
  })

  it('saves message attachments as file blocks before the text prompt', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    router(ctx, settings()).accept(message({
      text: '',
      attachments: [{ kind: 'file', key: 'file_v3_a', name: 'report.pdf' }, { kind: 'image', key: 'img_v3_b' }],
    }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(fetchResourceMock).toHaveBeenCalledTimes(2)
    expect(fetchResourceMock).toHaveBeenNthCalledWith(1, 'om_1', { kind: 'file', key: 'file_v3_a', name: 'report.pdf' })
    expect(fetchResourceMock).toHaveBeenNthCalledWith(2, 'om_1', { kind: 'image', key: 'img_v3_b' })
    expect(saveFileStream).toHaveBeenCalledTimes(2)
    expect(saveFileStream).toHaveBeenNthCalledWith(1, expect.objectContaining({ name: 'report.pdf' }))
    // An image carries no filename, so its resource key names the stored object.
    expect(saveFileStream).toHaveBeenNthCalledWith(2, expect.objectContaining({ name: 'img_v3_b' }))
    const submitted = followups.get(sessionId)?.mock.calls[0]?.[0]
    expect(submitted?.content[0]).toMatchObject({ type: 'file', attachment: { name: 'report.pdf' } })
    expect(submitted?.content[1]).toMatchObject({ type: 'file', attachment: { name: 'img_v3_b' } })
    expect(submitted?.content[2]?.text).toContain('Attachments: report.pdf, img_v3_b')
  })

  it('answers with the failure notice when an attachment download fails', async () => {
    const ctx = stubbedContext()
    fetchResourceMock.mockRejectedValueOnce(new Error('download rejected'))
    router(ctx, settings()).accept(message({ text: '', attachments: [{ kind: 'image', key: 'img_v3_x' }] }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_1', { kind: 'text', text: 'processing failed' }) })
    expect(saveFileStream).not.toHaveBeenCalled()
  })

  it('delivers files the turn declared through the deliver tool after the text reply', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      events.push({
        type: 'tool/call',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, callId: 'c1', name: 'feishu_deliver', arguments: JSON.stringify({ paths: ['/tmp/report.pdf', '/tmp/data.csv'] }) },
      } as SessionEvent)
      events.push({
        type: 'tool/call',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, callId: 'c2', name: 'bash', arguments: '{"command":"ls"}' },
      } as SessionEvent)
      events.push({
        type: 'assistant/message',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'files attached' }] } },
      } as SessionEvent)
    })
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(replyFile).toHaveBeenCalledTimes(2) })
    expect(reply).toHaveBeenCalledWith('om_1', { kind: 'text', text: 'files attached' })
    // Only the deliver tool's declarations reach the upload; bash calls contribute nothing.
    expect(replyFile).toHaveBeenNthCalledWith(1, 'om_1', { name: 'report.pdf', path: '/tmp/report.pdf' })
    expect(replyFile).toHaveBeenNthCalledWith(2, 'om_1', { name: 'data.csv', path: '/tmp/data.csv' })
  })

  it('delivers interactive cards the turn declared through the deliver tool before files', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    const card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: '日报' } }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**完成**' } }] }
    whenIdleBehaviors.set(sessionId, async (events) => {
      events.push({
        type: 'tool/call',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, callId: 'c1', name: 'feishu_deliver', arguments: JSON.stringify({ cards: [card], paths: ['/tmp/report.pdf'] }) },
      } as SessionEvent)
      events.push({
        type: 'assistant/message',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'card attached' }] } },
      } as SessionEvent)
    })
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(replyCard).toHaveBeenCalledOnce() })
    expect(replyCard).toHaveBeenCalledWith('om_1', card)
    expect(replyFile).toHaveBeenCalledOnce()
  })

  it('ignores card payloads without an elements array', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      events.push({
        type: 'tool/call',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, callId: 'c1', name: 'feishu_deliver', arguments: JSON.stringify({ cards: [{ header: { title: 'no elements' } }, 'not-an-object'] }) },
      } as SessionEvent)
      events.push({
        type: 'assistant/message',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'no valid cards' }] } },
      } as SessionEvent)
    })
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_1', { kind: 'text', text: 'no valid cards' }) })
    expect(replyCard).not.toHaveBeenCalled()
  })

  it('starts a fresh session when a reset command lands, keeping the old one persisted', async () => {
    const ctx = stubbedContext()
    const r = router(ctx, settings())
    // First ordinary message creates the generation-0 session.
    r.accept(message({ messageId: 'om_1', text: 'first topic' }))
    await vi.waitFor(() => {
      const settled = reply.mock.calls.at(-1)?.[1]
      expect(settled?.kind).toBe('text')
      expect(settled?.kind === 'text' ? settled.text : '').toContain('answer')
    })
    const firstSession = sessionIdForChat('oc_1', 0)
    expect(disposes.get(firstSession)).not.toHaveBeenCalled()
    // A reset command never reaches the agent; it only moves the chat pointer on.
    r.accept(message({ messageId: 'om_2', text: '/new' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_2', { kind: 'text', text: '已开启新会话（#1）。输入 /sessions 可查看历史会话，/switch <序号> 可切回。' }) })
    // The old agent stays alive (still listed in the Web UI), just unbound.
    expect(disposes.get(firstSession)).not.toHaveBeenCalled()
    expect(servedHandles.has(firstSession)).toBe(true)
    const followup0 = followups.get(firstSession)
    // The next ordinary message opens a different, fresh session.
    r.accept(message({ messageId: 'om_3', text: 'second topic' }))
    const secondSession = sessionIdForChat('oc_1', 1)
    await vi.waitFor(() => { expect(servedHandles.has(secondSession)).toBe(true) })
    expect(secondSession).not.toBe(firstSession)
    expect(followups.get(secondSession)).toHaveBeenCalledOnce()
    expect(followup0).toHaveBeenCalledOnce()
  })

  it('keeps the settled turn when one file delivery fails', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      events.push({
        type: 'tool/call',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, callId: 'c1', name: 'feishu_deliver', arguments: JSON.stringify({ paths: ['/tmp/only.pdf'] }) },
      } as SessionEvent)
      events.push({
        type: 'assistant/message',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'delivered' }] } },
      } as SessionEvent)
    })
    replyFile.mockRejectedValueOnce(new Error('upload quota exceeded'))
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(replyFile).toHaveBeenCalledOnce() })
    // The text reply already went out; the delivery failure never turns into the failure notice.
    expect(reply).toHaveBeenCalledWith('om_1', { kind: 'text', text: 'delivered' })
    expect(reply).not.toHaveBeenCalledWith('om_1', { kind: 'text', text: 'processing failed' })
  })

  it('rolls the creation transaction back when workspace attachment fails', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    workspace.attachSession.mockRejectedValueOnce(new Error('attach failed'))
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_1', { kind: 'text', text: 'processing failed' }) })
    expect(disposes.get(sessionId)).toHaveBeenCalledOnce()
    expect(servedHandles.has(sessionId)).toBe(false)
  })

  it('borrows a live agent another surface registered instead of resuming', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    externalAgents.set(sessionId, buildHandle(sessionId).agent)
    const agentsStubs = ctx.get('agents') as unknown as { resume: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(agentsStubs.create).not.toHaveBeenCalled()
    expect(agentsStubs.resume).not.toHaveBeenCalled()
    // The borrowed agent received the turn directly, and its deliver tool mounted on the agent scope.
    expect(followups.get(sessionId)).toHaveBeenCalledOnce()
    expect(mountedPlugins).toContain('feishu-deliver-tool')
  })

  it('resumes a persisted chat session under its durable preset', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    persistence.headers = [{ header: { id: sessionId } }]
    const agentsStubs = ctx.get('agents') as unknown as { resume: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(agentsStubs.resume).toHaveBeenCalledOnce()
    expect(agentsStubs.create).not.toHaveBeenCalled()
    expect(mountedPresets).toContain('logged-preset')
    expect(workspace.attachSession).not.toHaveBeenCalled()
  })

  it('truncates replies over the configured limit', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      events.push({
        type: 'assistant/message',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } },
      } as SessionEvent)
    })
    const live = { ...settings(), replyCharLimit: 500 }
    router(ctx, live).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    const content = reply.mock.calls[0]?.[1]
    expect(content?.kind).toBe('text')
    const text = content?.kind === 'text' ? content.text : ''
    expect(text.length).toBe(500)
    expect(text.endsWith('…')).toBe(true)
  })

  it('renders card-form replies under the configured title and limit', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      events.push({
        type: 'assistant/message',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'x'.repeat(600) }] } },
      } as SessionEvent)
    })
    const live: FeishuSettings = { ...settings(), replyForm: 'card', cardTitle: 'Ops', replyCharLimit: 500 }
    router(ctx, live).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    const content = reply.mock.calls[0]?.[1]
    expect(content?.kind).toBe('card')
    if (content?.kind !== 'card') return
    expect(content.card.header.title.content).toBe('Ops')
    expect(content.card.elements[0]?.content.length).toBe(500)
    expect(content.card.elements[0]?.content.endsWith('…')).toBe(true)
  })

  it('auto settles workflow turns as cards and plain turns as text', async () => {
    const workflowCtx = stubbedContext()
    const workflowSession = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(workflowSession, async (events) => {
      events.push({ type: 'tool-workflow/run-start', seq: events.length, time: 0, data: {} } as SessionEvent)
      events.push({
        type: 'assistant/message',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'workflow summary' }] } },
      } as SessionEvent)
    })
    router(workflowCtx, { ...settings(), replyForm: 'auto' }).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(reply.mock.calls[0]?.[1]?.kind).toBe('card')

    const plainCtx = stubbedContext()
    whenIdleBehaviors.set(sessionIdForChat('oc_1'), async (events) => {
      events.push({
        type: 'assistant/message',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'plain answer' }] } },
      } as SessionEvent)
    })
    router(plainCtx, { ...settings(), replyForm: 'auto' }).accept(message({ messageId: 'om_2' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    expect(reply.mock.calls[1]?.[1]?.kind).toBe('text')
  })

  it('auto failure notices stay text even when the turn ran a workflow', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      events.push({ type: 'tool-workflow/run-start', seq: events.length, time: 0, data: {} } as SessionEvent)
    })
    router(ctx, { ...settings(), replyForm: 'auto' }).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(reply).toHaveBeenCalledWith('om_1', { kind: 'text', text: 'processing failed' })
  })

  it('serializes messages of one chat behind the active turn', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    let releaseTurn: (() => void) | undefined
    let turns = 0
    whenIdleBehaviors.set(sessionId, async (events) => {
      turns += 1
      if (turns === 1) {
        await new Promise<void>((resolve) => {
          releaseTurn = resolve
        })
      }
      events.push({
        type: 'assistant/message',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'done' }] } },
      } as SessionEvent)
    })
    const subject = router(ctx, settings())
    subject.accept(message())
    subject.accept(message({ messageId: 'om_2' }))
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(reply).not.toHaveBeenCalled()
    releaseTurn?.()
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    const calls = followups.get(sessionId)?.mock.calls ?? []
    expect((calls[0]?.[0]?.content[0]?.text ?? '').endsWith('hello')).toBe(true)
  })
})
