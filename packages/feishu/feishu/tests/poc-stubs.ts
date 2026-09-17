/**
 * Shared stub harness for the POC use-case specs (T02/T03/T04/T11/T20/U07).
 * Provides a ConversationRouter over a real Cordis Context whose core services
 * are behavioral stubs, mirroring the component harness in C10.
 * @module poc-stubs
 */

import type { AttachmentId, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { vi, type Mock } from 'vitest'
import { ConversationRouter } from '../src/conversation.ts'
import type { FeishuSettings } from '../src/config.ts'
import type { InboundMessage } from '../src/types.ts'

/** Every field of a settings section, writable for live-edit tests. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

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
    replyCharLimit: 4000,
    failureNotice: 'processing failed',
    dedupCapacity: 64,
  }
}

/** One inbound chat message. */
export function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'p2p',
    senderOpenId: 'ou_1',
    text: 'critical alert on asset-a',
    attachments: [],
    mentioned: false,
    ...overrides,
  }
}

/** The reply sender the router resolves turns into. */
export const reply = vi.fn(async (_messageId: string, _text: string) => {})

/** The file reply sender the router delivers declared files through. */
export const replyFile = vi.fn(async (_messageId: string, _file: { name: string; path: string }) => {})

/** One downloaded attachment's resource descriptor. */
interface InboundAttachmentLike {
  kind: string
  key: string
  name?: string
}

/** The resource fetcher the router downloads attachments through. */
export const fetchResourceMock = vi.fn(
  async (_messageId: string, _attachment: InboundAttachmentLike): Promise<AsyncIterable<Uint8Array>> => attachmentBytes(),
)

/** One downloaded attachment's byte stream. */
async function* attachmentBytes(): AsyncIterable<Uint8Array> {
  yield Uint8Array.of(1, 2, 3)
}

/** The attachment store's saveFileStream stub, echoing a durable ref per name. */
export const saveFileStream = vi.fn(async ({ name }: { data: AsyncIterable<Uint8Array>; name: string }): Promise<FileAttachmentRef> => ({
  attachmentId: brandString<AttachmentId>(`att_${name}`),
  name,
  bytes: 3,
}))

/** Handles the stub agent registry served, keyed by session id. */
export const servedHandles = new Map<string, AgentHandle>()

/** Follow-up spies per session id, keyed like the router's handle map. */
export const followups = new Map<string, Mock<(message: { content: { type: string; text?: string }[] }) => void>>()

/** WhenIdle behavior hooks per handle; default appends one assistant reply. */
export const whenIdleBehaviors = new Map<string, (events: SessionEvent[]) => Promise<void>>()

/** One follow-up user message as the router submits it. */
export interface FollowupMessage {
  content: { type: string; text?: string }[]
}

/** Build one context whose core services are behavioral stubs. */
export function stubbedContext(): Context {
  const ctx = new Context()
  ctx.provide('agents', {
    create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      const handle = buildHandle(sessionId)
      servedHandles.set(sessionId, handle)
      return handle
    }),
    resume: vi.fn(),
    get: (id: string) => servedHandles.get(id)?.agent,
  })
  ctx.provide('agentPresets', {
    resolve: vi.fn(async (id: string) => ({ id })),
    standingKeyFor: vi.fn(async () => {}),
    mount: vi.fn(),
  })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) })
  ctx.provide('permissionPresets', { resolve: vi.fn(), set: vi.fn() })
  ctx.provide('workspaceRegistry', { create: vi.fn(async () => workspace) })
  ctx.provide('sessionTitle', { rename: vi.fn() })
  ctx.provide('sessionPersistence', { list: vi.fn(async () => []) })
  ctx.provide('attachments', { saveFileStream })
  return ctx
}

const workspace = {
  path: '/tmp/workspace',
  attachSession: vi.fn(async () => {}),
  detachSession: vi.fn(async () => {}),
}

/** Build one stub agent handle; whenIdle appends one assistant reply unless a hook overrides. */
export function buildHandle(sessionId: string): AgentHandle {
  const events: SessionEvent[] = []
  const followup = vi.fn((submitted: FollowupMessage) => {
    void submitted
    events.push({ type: 'user/message', seq: events.length, time: 0, data: {} } as SessionEvent)
  })
  followups.set(sessionId, followup)
  const agent = {
    ctx: { plugin: async () => {} },
    session: {
      id: sessionId,
      events,
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
  return { agent, dispose: vi.fn(async () => {}) } as unknown as AgentHandle
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
  )
}

/** Reinstall saveFileStream's echoing implementation after a reset. */
function echoSaveFileStream({ name }: { data: AsyncIterable<Uint8Array>; name: string }): Promise<FileAttachmentRef> {
  return Promise.resolve({
    attachmentId: brandString<AttachmentId>(`att_${name}`),
    name,
    bytes: 3,
  })
}

/** Reset every shared mock and map; call from afterEach. Clears both call history and per-test failure injections. */
export function resetStubs(): void {
  reply.mockReset().mockImplementation(async () => {})
  replyFile.mockReset().mockImplementation(async () => {})
  fetchResourceMock.mockReset().mockImplementation(async () => attachmentBytes())
  saveFileStream.mockReset().mockImplementation(echoSaveFileStream)
  servedHandles.clear()
  followups.clear()
  whenIdleBehaviors.clear()
}
