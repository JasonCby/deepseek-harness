/**
 * Shared stub harness for the ConversationRouter component specs (C10) and
 * the POC use-case specs split from it (T14 multi-turn isolation, T24
 * replaceability): one real Cordis Context whose core services are behavioral
 * stubs, mirroring poc-stubs but with the topic/interaction wiring C10 carries.
 * @module c10-stubs
 */

import type { AttachmentId, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import { ConversationRouter } from '../src/conversation.ts'
import type { FeishuSettings } from '../src/config.ts'
import type { ReplyContent } from '../src/reply.ts'
import type { InboundAttachment, InboundMessage } from '../src/types.ts'

/** Every field of a settings section, writable for live-edit tests. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** One mutable settings section the router reads live. */
export function settings(): Mutable<FeishuSettings> {
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
    interactionCards: {
      enabled: false,
      approval: { approveLabel: 'Approve', rejectLabel: 'Reject' },
      question: { title: 'Please answer', submitLabel: 'Submit' },
    },
  }
}

/** One inbound chat message. */
export function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
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
export const reply = vi.fn(async (_messageId: string, _content: ReplyContent) => {})

/** The single file reply sender the router delivers declared files through. */
export const replyFile = vi.fn(async (_messageId: string, _file: { name: string; path: string }) => {})

/** The single card reply sender the router delivers declared cards through. */
export const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => {})

/** One downloaded attachment's byte stream. */
async function* attachmentBytes(): AsyncIterable<Uint8Array> {
  yield Uint8Array.of(1, 2, 3)
}

/** The resource fetcher the router downloads attachments through. */
export const fetchResourceMock = vi.fn(
  async (_messageId: string, _attachment: InboundAttachment): Promise<AsyncIterable<Uint8Array>> => attachmentBytes(),
)

/** The attachment store's saveFileStream stub, echoing a durable ref per name. */
export const saveFileStream = vi.fn(async ({ name }: { data: AsyncIterable<Uint8Array>; name: string }): Promise<FileAttachmentRef> => ({
  attachmentId: brandString<AttachmentId>(`att_${name}`),
  name,
  bytes: 3,
}))

/** Handles the stub agent registry served, keyed by session id. */
export const servedHandles = new Map<string, AgentHandle>()
/** Live agents registered by another surface (the Web UI), keyed by session id. */
export const externalAgents = new Map<string, unknown>()
/** Session headers the stub persistence lists. */
export const persistence = { headers: [] as { header: { id: string } }[] }

export const contexts: Context[] = []

/** Preset mounts observed per handle scope. */
export const mountedPresets: string[] = []
export const mount = vi.fn(async (_agentCtx: unknown, _presetId: string) => {
  mountedPresets.push(_presetId)
})

export const workspace = {
  path: '/tmp/workspace',
  attachSession: vi.fn(async () => {}),
  detachSession: vi.fn(async () => {}),
}

/** Follow-up spies per session id, keyed like the router's handle map. */
export const followups = new Map<string, Mock<(message: FollowupMessage) => void>>()
export const disposes = new Map<string, ReturnType<typeof vi.fn>>()
/** WhenIdle behavior hooks per handle; default appends one assistant reply. */
export const whenIdleBehaviors = new Map<string, (events: SessionEvent[]) => Promise<void>>()

/** One content block of a follow-up user message, text or file. */
interface FollowupBlock {
  type: string
  text?: string
  attachment?: FileAttachmentRef
}

/** One follow-up user message as the router submits it. */
export interface FollowupMessage {
  content: FollowupBlock[]
  source: { kind: string }
}

/** The agent-scoped context stub: records plugins the router mounts on it. */
export const mountedPlugins: string[] = []
function agentCtxStub(): { plugin: (plugin: { name: string }) => Promise<void> } {
  return { plugin: async (plugin) => { mountedPlugins.push(plugin.name) } }
}

/** Build one stub agent handle with a synchronous one-reply turn. */
export function buildHandle(sessionId: string): AgentHandle {
  const events: SessionEvent[] = []
  const followup = vi.fn((submitted: FollowupMessage) => {
    void submitted
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

/** Build one context whose core services are behavioral stubs. */
export function stubbedContext(): Context {
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
    mount,
  })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) })
  ctx.provide('permissionPresets', { resolve: vi.fn(), set: vi.fn() })
  ctx.provide('workspaceRegistry', { create: vi.fn(async () => workspace) })
  ctx.provide('sessionTitle', { rename: vi.fn() })
  ctx.provide('sessionPersistence', { list: vi.fn(async () => persistence.headers) })
  ctx.provide('attachments', { saveFileStream })
  return ctx
}

/** Build the router over one stubbed context. */
export function router(ctx: Context, live: FeishuSettings): ConversationRouter {
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

/** Point $DSH_HOME at a fresh temp dir so generation state never leaks out. */
export function isolateHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-test-'))
  process.env.DSH_HOME = dir
  return dir
}

/** Drop the isolated $DSH_HOME and remove its directory. */
export function restoreHome(dir: string): void {
  process.env.DSH_HOME = undefined
  rmSync(dir, { recursive: true, force: true })
}

/** Reset every shared mock and map; call from afterEach. */
export function resetC10(): void {
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
  whenIdleBehaviors.clear()
  mountedPresets.length = 0
  persistence.headers = []
  contexts.forEach(context => void context.fiber.dispose())
  contexts.length = 0
}
