/** ConversationRouter behavior tests over a real Cordis Context with stubbed core services. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ConversationRouter, sessionIdForChat, sessionIdForThread } from '../src/conversation.ts'
import type { FeishuSettings } from '../src/config.ts'
import type { ReplyContent } from '../src/reply.ts'
import type { InboundMessage } from '../src/types.ts'

/** One mutable settings section the router reads live. */
function settings(): FeishuSettings {
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
    failureNotice: 'processing failed',
    dedupCapacity: 64,
    cardTemplates: [],
  }
}

/** One inbound chat message. */
function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'p2p',
    senderOpenId: 'ou_1',
    text: 'hello',
    mentioned: false,
    ...overrides,
  }
}

/** The single reply sender the router resolves turns into. */
const reply = vi.fn(async (_messageId: string, _content: ReplyContent) => {})

/** Handles the stub agent registry served, keyed by session id. */
const servedHandles = new Map<string, AgentHandle>()
/** Session headers the stub persistence lists. */
let persistedHeaders: { header: { id: string } }[] = []

let contexts: Context[] = []

/** Build one context whose core services are behavioral stubs. */
function stubbedContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('agents', {
    create: vi.fn(async ({ sessionId, setup }: { sessionId: string; setup?: (agentCtx: unknown, agent: unknown) => Promise<void> }) => {
      const handle = buildHandle(sessionId)
      if (setup !== undefined) await setup({}, handle.agent)
      servedHandles.set(sessionId, handle)
      return handle
    }),
    resume: vi.fn(async ({ resumeSessionId, setup }: {
      resumeSessionId: string
      setup?: (agentCtx: unknown, agent: unknown) => Promise<void>
    }) => {
      const handle = buildHandle(resumeSessionId)
      if (setup !== undefined) await setup({}, handle.agent)
      servedHandles.set(resumeSessionId, handle)
      return handle
    }),
    get: (id: string) => servedHandles.get(id)?.agent,
  })
  ctx.provide('agentPresets', {
    resolve: vi.fn(async (id: string) => ({ id })),
    standingKeyFor: vi.fn(async () => {}),
    mount: mount,
  })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) })
  ctx.provide('permissionPresets', { resolve: vi.fn(), set: vi.fn() })
  ctx.provide('workspaceRegistry', { create: vi.fn(async () => workspace) })
  ctx.provide('sessionTitle', { rename: vi.fn() })
  ctx.provide('sessionPersistence', { list: vi.fn(async () => persistedHeaders) })
  return ctx
}

/** Preset mounts observed per handle scope. */
const mountedPresets: string[] = []
const mount = vi.fn(async (_agentCtx: unknown, presetId: string) => {
  mountedPresets.push(presetId)
})

const workspace = {
  path: '/tmp/workspace',
  attachSession: vi.fn(async () => {}),
  detachSession: vi.fn(async () => {}),
}

/** Followup and dispose spies per handle, keyed by session id. */
/** Follow-up spies per session id, keyed like the router's handle map. */
const followups = new Map<string, Mock<(message: FollowupMessage) => void>>()
const disposes = new Map<string, ReturnType<typeof vi.fn>>()
/** WhenIdle behavior hooks per handle; default appends one assistant reply. */
const whenIdleBehaviors = new Map<string, (events: SessionEvent[]) => Promise<void>>()

/** One follow-up user message as the router submits it. */
interface FollowupMessage {
  content: { type: string; text: string }[]
  source: { kind: string }
}

/** Build one stub agent handle with a synchronous one-reply turn. */
function buildHandle(sessionId: string): AgentHandle {
  const events: SessionEvent[] = []
  const followup = vi.fn((message: FollowupMessage) => {
    void message
    events.push({ type: 'user/message', seq: events.length, time: 0, data: {} } as SessionEvent)
  })
  followups.set(sessionId, followup)
  const dispose = vi.fn(async () => {
    servedHandles.delete(sessionId)
  })
  disposes.set(sessionId, dispose)
  const agent = {
    session: {
      id: sessionId,
      get seq(): number {
        return events.length
      },
      snapshotEvents: (): readonly SessionEvent[] => events,
      header: { agentPreset: 'logged-preset' },
    },
    followup,
    whenIdle: vi.fn(async () => {
      const hook = whenIdleBehaviors.get(sessionId)
      if (hook !== undefined) {
        await hook(events)
        return
      }
      events.push({
        type: 'assistant/message',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: `answer ${String(events.length)}` }] } },
      } as SessionEvent)
    }),
  }
  return { agent, dispose } as unknown as AgentHandle
}

/** Build the router over one stubbed context. */
function router(ctx: Context, live: FeishuSettings): ConversationRouter {
  return new ConversationRouter(
    ctx,
    { workspacePath: workspace.path, agentPreset: 'standard', permissionPreset: 'read-only' },
    () => live,
    reply,
  )
}

afterEach(() => {
  reply.mockClear()
  mount.mockClear()
  workspace.attachSession.mockClear()
  workspace.detachSession.mockClear()
  servedHandles.clear()
  followups.clear()
  disposes.clear()
  whenIdleBehaviors.clear()
  mountedPresets.length = 0
  persistedHeaders = []
  contexts.forEach(context => void context.fiber.dispose())
  contexts = []
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
    expect(first?.content[0]?.text.endsWith('hello')).toBe(true)
    expect(title).toHaveBeenCalledWith(expect.anything(), 'Feishu chat oc_1')
    expect(presets.set).toHaveBeenCalledWith(expect.anything(), 'read-only')
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

  it('routes topic messages to their own session beside the chat main stream', async () => {
    const ctx = stubbedContext()
    const create = (ctx.get('agents') as unknown as { create: ReturnType<typeof vi.fn> }).create
    const title = (ctx.get('sessionTitle') as unknown as { rename: ReturnType<typeof vi.fn> }).rename
    const subject = router(ctx, settings())
    subject.accept(message({ messageId: 'om_main' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    subject.accept(message({ messageId: 'om_t1', threadId: 'omt_1' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    subject.accept(message({ messageId: 'om_t1b', threadId: 'omt_1' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(3) })
    expect(create).toHaveBeenCalledTimes(2)
    expect(followups.get(sessionIdForChat('oc_1'))).toHaveBeenCalledTimes(1)
    expect(followups.get(sessionIdForThread('oc_1', 'omt_1'))).toHaveBeenCalledTimes(2)
    expect(title).toHaveBeenCalledWith(expect.anything(), 'Feishu chat oc_1')
    expect(title).toHaveBeenCalledWith(expect.anything(), 'Feishu chat oc_1 topic omt_1')
  })

  it('opens one topic per main-stream message when replyInThread is on', async () => {
    const ctx = stubbedContext()
    const opened: { messageId: string; summary: string }[] = []
    const subject = router(ctx, { ...settings(), replyInThread: true })
    subject.setTopicOpener({
      open: async (messageId, summary) => {
        opened.push({ messageId, summary })
        return { leadMessageId: 'om_lead', threadId: 'omt_new' }
      },
    })
    subject.accept(message({ text: 'multi\nline   question' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(opened).toEqual([{ messageId: 'om_1', summary: 'multi line question' }])
    expect(reply).toHaveBeenCalledWith('om_lead', expect.objectContaining({ kind: 'text' }))
    expect(followups.get(sessionIdForThread('oc_1', 'omt_new'))).toHaveBeenCalledOnce()
  })

  it('continues an existing topic without opening another when replyInThread is on', async () => {
    const ctx = stubbedContext()
    let opens = 0
    const subject = router(ctx, { ...settings(), replyInThread: true })
    subject.setTopicOpener({
      open: async () => {
        opens += 1
        return { leadMessageId: 'om_lead', threadId: 'omt_x' }
      },
    })
    subject.accept(message({ messageId: 'om_t', threadId: 'omt_1' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(opens).toBe(0)
    expect(reply).toHaveBeenCalledWith('om_t', expect.objectContaining({ kind: 'text' }))
    expect(followups.get(sessionIdForThread('oc_1', 'omt_1'))).toHaveBeenCalledOnce()
  })

  it('degrades to an in-place reply when topic opening fails', async () => {
    const ctx = stubbedContext()
    const subject = router(ctx, { ...settings(), replyInThread: true })
    subject.setTopicOpener({
      open: async () => { throw new Error('topic refused') },
    })
    subject.accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(reply).toHaveBeenCalledWith('om_1', expect.objectContaining({ kind: 'text' }))
    expect(followups.get(sessionIdForChat('oc_1'))).toHaveBeenCalledOnce()
  })

  it('renders a bound platform template for a workflow turn', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      events.push({ type: 'tool/call', seq: events.length, time: 0, data: { turn: 0, step: 0, callId: 'c1', name: 'workflow', arguments: '{}' } } as SessionEvent)
      events.push({ type: 'tool-workflow/run-start', seq: events.length, time: 0, data: { runId: 'r1', name: 'alarm-report' } } as SessionEvent)
      events.push({
        type: 'tool/result', seq: events.length, time: 0,
        data: { turn: 0, step: 0, message: { id: 'm4', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }], role: 'user' }, meta: { runId: 'r1', name: 'alarm-report', result: { reply: 'handled' } } },
      } as unknown as SessionEvent)
      events.push({
        type: 'assistant/message', seq: events.length, time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'workflow done' }] } },
      } as SessionEvent)
    })
    const live: FeishuSettings = {
      ...settings(),
      replyForm: 'auto',
      cardTemplates: [{
        name: 'alarm',
        bindTool: 'workflow',
        templateId: 'AAq1',
        variables: {
          who: { from: 'context', key: 'senderOpenId', required: true },
          reply: { from: 'tool-result', path: 'result.reply', required: true },
        },
      }],
    }
    router(ctx, live).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(reply).toHaveBeenCalledWith('om_1', {
      kind: 'template',
      templateId: 'AAq1',
      variables: { who: 'ou_1', reply: 'handled' },
    })
  })

  it('renders a builder multilingual card export as the canonical 1.0 card', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      events.push({ type: 'tool/call', seq: events.length, time: 0, data: { turn: 0, step: 0, callId: 'c1', name: 'workflow', arguments: '{}' } } as SessionEvent)
      events.push({ type: 'tool-workflow/run-start', seq: events.length, time: 0, data: { runId: 'r1', name: 'n' } } as SessionEvent)
      events.push({
        type: 'tool/result', seq: events.length, time: 0,
        data: { turn: 0, step: 0, message: { id: 'm4', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }], role: 'user' }, meta: { result: { reply: 'handled' } } },
      } as unknown as SessionEvent)
      events.push({
        type: 'assistant/message', seq: events.length, time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'workflow done' }] } },
      } as SessionEvent)
    })
    const live: FeishuSettings = {
      ...settings(),
      replyForm: 'auto',
      cardTemplates: [{
        name: 'alarm',
        bindTool: 'workflow',
        card: {
          config: { update_multi: true },
          i18n_elements: { zh_cn: [{ tag: 'markdown', content: '任务完成:{{summary}}' }] },
          i18n_header: { zh_cn: { title: { tag: 'plain_text', content: '告警' }, template: 'red' } },
        },
        variables: { summary: { from: 'tool-result', path: 'result.reply', required: true } },
      }],
    }
    router(ctx, live).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(reply).toHaveBeenCalledWith('om_1', {
      kind: 'localCard',
      card: {
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: '告警' }, template: 'red' },
        elements: [{ tag: 'markdown', content: '任务完成:handled' }],
      },
    })
  })

  it('falls back to the markdown card when a required template variable is unresolvable', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      events.push({ type: 'tool/call', seq: events.length, time: 0, data: { turn: 0, step: 0, callId: 'c1', name: 'workflow', arguments: '{}' } } as SessionEvent)
      events.push({ type: 'tool-workflow/run-start', seq: events.length, time: 0, data: { runId: 'r1', name: 'n' } } as SessionEvent)
      events.push({
        type: 'assistant/message', seq: events.length, time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'workflow done' }] } },
      } as SessionEvent)
    })
    const live: FeishuSettings = {
      ...settings(),
      replyForm: 'auto',
      cardTemplates: [{
        name: 'alarm',
        bindTool: 'workflow',
        templateId: 'AAq1',
        variables: { reply: { from: 'tool-result', path: 'result.reply', required: true } },
      }],
    }
    router(ctx, live).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(reply.mock.calls[0]?.[1]?.kind).toBe('card')
  })

  it('retries a refused template delivery as the markdown card', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      events.push({ type: 'tool/call', seq: events.length, time: 0, data: { turn: 0, step: 0, callId: 'c1', name: 'workflow', arguments: '{}' } } as SessionEvent)
      events.push({ type: 'tool-workflow/run-start', seq: events.length, time: 0, data: { runId: 'r1', name: 'n' } } as SessionEvent)
      events.push({
        type: 'tool/result', seq: events.length, time: 0,
        data: { turn: 0, step: 0, message: { id: 'm4', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }], role: 'user' }, meta: { result: { reply: 'handled' } } },
      } as unknown as SessionEvent)
      events.push({
        type: 'assistant/message', seq: events.length, time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'workflow done' }] } },
      } as SessionEvent)
    })
    const live: FeishuSettings = {
      ...settings(),
      replyForm: 'auto',
      cardTemplates: [{ name: 'alarm', bindTool: 'workflow', templateId: 'AAq1', variables: {} }],
    }
    reply.mockRejectedValueOnce(new Error('feishu reply failed with code 230099'))
    router(ctx, live).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    expect(reply.mock.calls[0]?.[1]?.kind).toBe('template')
    expect(reply.mock.calls[1]?.[1]?.kind).toBe('card')
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

  it('rolls the creation transaction back when workspace attachment fails', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    workspace.attachSession.mockRejectedValueOnce(new Error('attach failed'))
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_1', { kind: 'text', text: 'processing failed' }) })
    expect(disposes.get(sessionId)).toHaveBeenCalledOnce()
    expect(servedHandles.has(sessionId)).toBe(false)
  })

  it('resumes a persisted chat session under its durable preset', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    persistedHeaders = [{ header: { id: sessionId } }]
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
    expect(calls[0]?.[0]?.content[0]?.text.endsWith('hello')).toBe(true)
  })
})
