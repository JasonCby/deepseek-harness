/** C10: ConversationRouter behavior tests over a real Cordis Context with stubbed core services. */

import type { AttachmentId, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ConversationRouter, sessionIdForChat } from '../src/conversation.ts'
import type { FeishuSettings } from '../src/config.ts'
import type { InboundAttachment, InboundMessage } from '../src/types.ts'

/** Every field of a settings section, writable for live-edit tests. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** One mutable settings section the router reads live. */
function settings(): Mutable<FeishuSettings> {
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
    failureNotice: 'processing failed',
    dedupCapacity: 64,
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
    attachments: [],
    mentioned: false,
    ...overrides,
  }
}

/** The single reply sender the router resolves turns into. */
const reply = vi.fn(async (_messageId: string, _text: string) => {})

/** The single file reply sender the router delivers declared files through. */
const replyFile = vi.fn(async (_messageId: string, _file: { name: string; path: string }) => {})

/** The resource fetcher the router downloads attachments through. */
const fetchResourceMock = vi.fn(
  async (_messageId: string, _attachment: InboundAttachment): Promise<AsyncIterable<Uint8Array>> => attachmentBytes(),
)

/** One downloaded attachment's byte stream. */
async function* attachmentBytes(): AsyncIterable<Uint8Array> {
  yield Uint8Array.of(1, 2, 3)
}

/** The attachment store's saveFileStream stub, echoing a durable ref per name. */
const saveFileStream = vi.fn(async ({ name }: { data: AsyncIterable<Uint8Array>; name: string }): Promise<FileAttachmentRef> => ({
  attachmentId: brandString<AttachmentId>(`att_${name}`),
  name,
  bytes: 3,
}))

/** Handles the stub agent registry served, keyed by session id. */
const servedHandles = new Map<string, AgentHandle>()
/** Live agents registered by another surface (the Web UI), keyed by session id. */
const externalAgents = new Map<string, unknown>()
/** Session headers the stub persistence lists. */
let persistedHeaders: { id: string }[] = []

let contexts: Context[] = []

/** Build one context whose core services are behavioral stubs. */
function stubbedContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('agents', {
    create: vi.fn(async ({ sessionId, setup }: { sessionId: string; setup?: (agentCtx: unknown, agent: unknown) => Promise<void> }) => {
      const handle = buildHandle(sessionId)
      if (setup !== undefined) await setup(agentCtxStub(), handle.agent)
      servedHandles.set(sessionId, handle)
      return handle
    }),
    resume: vi.fn(async ({ resumeSessionId, setup }: {
      resumeSessionId: string
      setup?: (agentCtx: unknown, agent: unknown) => Promise<void>
    }) => {
      const handle = buildHandle(resumeSessionId)
      if (setup !== undefined) await setup(agentCtxStub(), handle.agent)
      servedHandles.set(resumeSessionId, handle)
      return handle
    }),
    get: (id: string) => servedHandles.get(id)?.agent ?? externalAgents.get(id),
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
  ctx.provide('sessionPersistence', { list: vi.fn(async () => persistedHeaders.map(header => ({ header }))) })
  ctx.provide('attachments', { saveFileStream })
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

/** One content block of a follow-up user message, text or file. */
interface FollowupBlock {
  type: string
  text?: string
  attachment?: FileAttachmentRef
}

/** One follow-up user message as the router submits it. */
interface FollowupMessage {
  content: FollowupBlock[]
  source: { kind: string }
}

/** The agent-scoped context stub: records plugins the router mounts on it. */
const mountedPlugins: string[] = []
function agentCtxStub(): { plugin: (plugin: { name: string }) => Promise<void> } {
  return { plugin: async (plugin) => { mountedPlugins.push(plugin.name) } }
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
    ctx: agentCtxStub(),
    session: {
      id: sessionId,
      events,
      // The V3 read surface the router consumes: next seq and a snapshot copy.
      get seq() { return events.length },
      snapshotEvents: () => events,
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
    replyFile,
    fetchResourceMock,
  )
}

afterEach(() => {
  reply.mockClear()
  replyFile.mockClear()
  mountedPlugins.length = 0
  fetchResourceMock.mockClear()
  saveFileStream.mockClear()
  mount.mockClear()
  workspace.attachSession.mockClear()
  workspace.detachSession.mockClear()
  servedHandles.clear()
  externalAgents.clear()
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
    expect((first?.content[0]?.text ?? '').endsWith('hello')).toBe(true)
    expect(title).toHaveBeenCalledWith(expect.anything(), 'Feishu chat oc_1')
    expect(presets.set).toHaveBeenCalledWith(expect.anything(), 'read-only')
    expect(mountedPlugins).toContain('feishu-deliver-tool')
    expect(workspace.attachSession).toHaveBeenCalledWith(sessionId)
    expect(reply).toHaveBeenCalledWith('om_1', expect.stringMatching(/^answer /) as string)
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
    const live = settings()
    live.allowChatIds = ['oc_allowed']
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
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_1', 'processing failed') })
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
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_1', 'processing failed') })
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
    expect(reply).toHaveBeenCalledWith('om_1', 'files attached')
    // Only the deliver tool's declarations reach the upload; bash calls contribute nothing.
    expect(replyFile).toHaveBeenNthCalledWith(1, 'om_1', { name: 'report.pdf', path: '/tmp/report.pdf' })
    expect(replyFile).toHaveBeenNthCalledWith(2, 'om_1', { name: 'data.csv', path: '/tmp/data.csv' })
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
    expect(reply).toHaveBeenCalledWith('om_1', 'delivered')
    expect(reply).not.toHaveBeenCalledWith('om_1', 'processing failed')
  })

  it('rolls the creation transaction back when workspace attachment fails', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    workspace.attachSession.mockRejectedValueOnce(new Error('attach failed'))
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_1', 'processing failed') })
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
    persistedHeaders = [{ id: sessionId }]
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
    const live = settings()
    live.replyCharLimit = 500
    router(ctx, live).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    const text = reply.mock.calls[0]?.[1] ?? ''
    expect(text.length).toBe(500)
    expect(text.endsWith('…')).toBe(true)
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
