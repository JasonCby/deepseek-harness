/** T04: /sessions and /switch command behavior over a real Cordis Context with stubbed core services. */

import type { AttachmentId, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** The single card reply sender the router delivers declared cards through. */
const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => {})

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
let persistedHeaders: { id: string; createdAt?: number }[] = []

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

/** Follow-up spies per session id, keyed like the router's handle map. */
const followups = new Map<string, Mock<(message: FollowupMessage) => void>>()
const disposes = new Map<string, ReturnType<typeof vi.fn>>()

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
    replyCard,
  )
}

/** All reply texts sent so far, in order. */
function replyTexts(): string[] {
  return reply.mock.calls.map(call => call[1])
}

/** Temporary DSH_HOME each test writes its router state file into. */
let homeDir: string

beforeEach(() => {
  // The router persists chat generations under $DSH_HOME; isolate each test so
  // commands never leak oc_1 generations into the real ~/.dsh.
  homeDir = mkdtempSync(join(tmpdir(), 'dsh-feishu-test-'))
  process.env.DSH_HOME = homeDir
})

afterEach(() => {
  process.env.DSH_HOME = undefined
  rmSync(homeDir, { recursive: true, force: true })
  reply.mockClear()
  replyFile.mockClear()
  replyCard.mockClear()
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
  mountedPresets.length = 0
  persistedHeaders = []
  contexts.forEach(context => void context.fiber.dispose())
  contexts = []
})

describe('session commands', () => {
  it('lists generation 0 as fresh current before any session exists', async () => {
    const ctx = stubbedContext()
    router(ctx, settings()).accept(message({ text: '/sessions' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    const list = replyTexts()[0] ?? ''
    expect(list).toContain('本会话群共有 1 个会话世代')
    expect(list).toContain('▶ #0')
    expect(list).toContain('（当前，新会话尚未开始）')
    // Listing alone never spins up an agent.
    expect(servedHandles.size).toBe(0)
  })

  it('lists the current generation without moving the pointer', async () => {
    const ctx = stubbedContext()
    const subject = router(ctx, settings())
    subject.accept(message({ text: 'first topic' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    const generation0 = sessionIdForChat('oc_1', 0)
    persistedHeaders = [{ id: generation0, createdAt: 1758000000000 }]
    subject.accept(message({ messageId: 'om_2', text: '/sessions' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    const list = replyTexts()[1] ?? ''
    expect(list).toContain('#0')
    expect(list).toContain('（当前）')
    expect(list).toContain('▶')
    // The pointer stayed put: the next ordinary message enters the same session.
    subject.accept(message({ messageId: 'om_3', text: 'second turn' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(3) })
    expect(followups.get(generation0)).toHaveBeenCalledTimes(2)
  })

  it('lists every generation newest-first after /new, marking the newest current', async () => {
    const ctx = stubbedContext()
    const subject = router(ctx, settings())
    subject.accept(message({ text: 'topic a' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    subject.accept(message({ messageId: 'om_2', text: '/new' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    subject.accept(message({ messageId: 'om_3', text: 'topic b' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(3) })
    persistedHeaders = [
      { id: sessionIdForChat('oc_1', 0), createdAt: 1758000000000 },
      { id: sessionIdForChat('oc_1', 1), createdAt: 1758000100000 },
    ]
    subject.accept(message({ messageId: 'om_4', text: '/sessions' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(4) })
    const list = replyTexts()[3] ?? ''
    expect(list).toContain('本会话群共有 2 个会话世代')
    expect(list.indexOf('#1')).toBeLessThan(list.indexOf('#0'))
    const currentLine = list.split('\n').find(line => line.includes('（当前）'))
    expect(currentLine).toContain('#1')
  })

  it('lists the fresh current generation before its first message', async () => {
    const ctx = stubbedContext()
    const subject = router(ctx, settings())
    subject.accept(message({ text: 'topic a' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    persistedHeaders = [{ id: sessionIdForChat('oc_1', 0), createdAt: 1758000000000 }]
    subject.accept(message({ messageId: 'om_2', text: '/new' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    // Generation 1 has no persisted session yet, but as the routing target it
    // must stay visible instead of vanishing from the list.
    subject.accept(message({ messageId: 'om_3', text: '/sessions' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(3) })
    const list = replyTexts()[2] ?? ''
    expect(list).toContain('本会话群共有 2 个会话世代')
    const currentLine = list.split('\n').find(line => line.includes('▶'))
    expect(currentLine).toContain('#1')
    expect(currentLine).toContain('（当前，新会话尚未开始）')
    expect(list).toContain('#0')
  })

  it('marks generations a /new left unused so rows match the count', async () => {
    const ctx = stubbedContext()
    const subject = router(ctx, settings())
    subject.accept(message({ text: 'topic a' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    persistedHeaders = [{ id: sessionIdForChat('oc_1', 0), createdAt: 1758000000000 }]
    // Two resets in a row: generation 1 never carried a message before the
    // pointer moved on to generation 2.
    subject.accept(message({ messageId: 'om_2', text: '/new' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    subject.accept(message({ messageId: 'om_3', text: '/new' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(3) })
    subject.accept(message({ messageId: 'om_4', text: '/sessions' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(4) })
    const list = replyTexts()[3] ?? ''
    expect(list).toContain('本会话群共有 3 个会话世代')
    const gapLine = list.split('\n').find(line => line.includes('#1'))
    expect(gapLine).toContain('（未使用）')
    const currentLine = list.split('\n').find(line => line.includes('▶'))
    expect(currentLine).toContain('#2')
    expect(currentLine).toContain('（当前，新会话尚未开始）')
    expect(list).toContain('#0')
  })

  it('switches the pointer back to an earlier generation', async () => {
    const ctx = stubbedContext()
    const subject = router(ctx, settings())
    subject.accept(message({ text: 'topic a' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    subject.accept(message({ messageId: 'om_2', text: '/new' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    subject.accept(message({ messageId: 'om_3', text: 'topic b' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(3) })
    const generation0 = sessionIdForChat('oc_1', 0)
    const generation1 = sessionIdForChat('oc_1', 1)
    expect(followups.get(generation0)).toHaveBeenCalledOnce()
    expect(followups.get(generation1)).toHaveBeenCalledOnce()
    subject.accept(message({ messageId: 'om_4', text: '/switch 0' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_4', '已切换到会话 #0。下一条消息将进入该会话。') })
    // The old session was only unbound, never disposed.
    expect(disposes.get(generation1)).not.toHaveBeenCalled()
    subject.accept(message({ messageId: 'om_5', text: 'back to topic a' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(5) })
    expect(followups.get(generation0)).toHaveBeenCalledTimes(2)
    expect(followups.get(generation1)).toHaveBeenCalledOnce()
  })

  it('rejects malformed switch arguments without moving the pointer', async () => {
    const ctx = stubbedContext()
    const subject = router(ctx, settings())
    subject.accept(message({ text: 'topic a' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    subject.accept(message({ messageId: 'om_2', text: '/new' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    subject.accept(message({ messageId: 'om_3', text: 'topic b' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(3) })
    subject.accept(message({ messageId: 'om_4', text: '/switch' }))
    subject.accept(message({ messageId: 'om_5', text: '/switch abc' }))
    subject.accept(message({ messageId: 'om_6', text: '/switch 5' }))
    subject.accept(message({ messageId: 'om_7', text: '/switch <>' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(7) })
    for (const text of replyTexts().slice(3)) {
      expect(text).toContain('用法：/switch <序号>（0 到 1）')
    }
    // The pointer never moved: ordinary traffic still lands in generation 1.
    subject.accept(message({ messageId: 'om_8', text: 'still topic b' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(8) })
    expect(followups.get(sessionIdForChat('oc_1', 1))).toHaveBeenCalledTimes(2)
  })

  it('reports already-current on a no-op switch, tolerating usage brackets', async () => {
    const ctx = stubbedContext()
    const subject = router(ctx, settings())
    subject.accept(message({ text: 'topic a' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    subject.accept(message({ messageId: 'om_2', text: '/switch 0' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_2', '当前已在会话 #0。') })
    // Angle brackets copied from the usage text parse the same.
    subject.accept(message({ messageId: 'om_3', text: '/switch <0>' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_3', '当前已在会话 #0。') })
  })

  it('opens the next ceiling generation when /new follows a switch-back', async () => {
    const ctx = stubbedContext()
    const subject = router(ctx, settings())
    subject.accept(message({ text: 'topic a' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    subject.accept(message({ messageId: 'om_2', text: '/new' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    subject.accept(message({ messageId: 'om_3', text: 'topic b' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(3) })
    subject.accept(message({ messageId: 'om_4', text: '/switch 0' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(4) })
    // current is 0 but the ceiling is 1: the next /new must open generation 2,
    // never re-hashing onto generation 1's existing session id.
    subject.accept(message({ messageId: 'om_5', text: '/new' }))
    await vi.waitFor(() => {
      expect(reply).toHaveBeenCalledWith('om_5', '已开启新会话（#2）。输入 /sessions 可查看历史会话，/switch <序号> 可切回。')
    })
    subject.accept(message({ messageId: 'om_6', text: 'topic c' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(6) })
    const generation2 = sessionIdForChat('oc_1', 2)
    expect(followups.get(generation2)).toHaveBeenCalledOnce()
    // The skipped-over generation keeps its single turn.
    expect(followups.get(sessionIdForChat('oc_1', 1))).toHaveBeenCalledOnce()
  })

  it('restores the pointer and ceiling across a restart', async () => {
    const first = stubbedContext()
    const subjectA = router(first, settings())
    subjectA.accept(message({ text: 'topic a' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    subjectA.accept(message({ messageId: 'om_2', text: '/new' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    subjectA.accept(message({ messageId: 'om_3', text: 'topic b' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(3) })
    subjectA.accept(message({ messageId: 'om_4', text: '/switch 0' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(4) })
    // A fresh router over the same DSH_HOME resumes routing at generation 0.
    const second = stubbedContext()
    router(second, settings()).accept(message({ messageId: 'om_5', text: 'after restart' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(5) })
    expect(followups.get(sessionIdForChat('oc_1', 0))).toHaveBeenCalledTimes(2)
  })

  it('migrates a legacy bare-epoch state file', async () => {
    writeFileSync(join(homeDir, 'feishu-router-state.json'), JSON.stringify({ oc_1: 2 }), 'utf8')
    const ctx = stubbedContext()
    const subject = router(ctx, settings())
    subject.accept(message({ text: 'after migration' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    // Legacy value 2 becomes {current: 2, max: 2}: traffic routes to generation 2.
    expect(followups.get(sessionIdForChat('oc_1', 2))).toHaveBeenCalledOnce()
    // And /new extends the migrated ceiling.
    subject.accept(message({ messageId: 'om_2', text: '/new' }))
    await vi.waitFor(() => {
      expect(reply).toHaveBeenCalledWith('om_2', '已开启新会话（#3）。输入 /sessions 可查看历史会话，/switch <序号> 可切回。')
    })
  })

  it('keeps commands out of the session log', async () => {
    const ctx = stubbedContext()
    const subject = router(ctx, settings())
    subject.accept(message({ text: 'topic a' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    subject.accept(message({ messageId: 'om_2', text: '/sessions' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    subject.accept(message({ messageId: 'om_3', text: '/switch 0' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(3) })
    subject.accept(message({ messageId: 'om_4', text: 'topic a continued' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(4) })
    const generation0 = sessionIdForChat('oc_1', 0)
    // Only the two ordinary messages reached the agent; commands left no trace.
    expect(followups.get(generation0)).toHaveBeenCalledTimes(2)
    for (const call of followups.get(generation0)?.mock.calls ?? []) {
      const text = call[0]?.content[0]?.text ?? ''
      expect(text).not.toContain('/sessions')
      expect(text).not.toContain('/switch')
    }
  })

  it('ignores commands that fail the group mention gate', async () => {
    const ctx = stubbedContext()
    const subject = router(ctx, settings())
    subject.accept(message({ text: '/sessions', chatType: 'group', mentioned: false }))
    subject.accept(message({ messageId: 'om_2', text: '/switch 0', chatType: 'group', mentioned: false }))
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(reply).not.toHaveBeenCalled()
    expect(servedHandles.size).toBe(0)
  })
})
