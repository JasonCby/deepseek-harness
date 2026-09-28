/**
 * Shared harness for the Skill enforcement e2e specs (T25/T26): the real
 * ConversationRouter over a real AgentLoop (GLM via anthropic-messages), real
 * filesystem and bash tools, plus a fake 灯塔-7 business API on a local port
 * that receipts every S2/S3/S5 call in arrival order.
 * @module skill-e2e-harness
 */

import type { AttachmentId, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context } from '@deepseek-ai/cordis'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { expect, vi, type Mock } from 'vitest'
import { ConversationRouter, sessionIdForChat } from '../src/conversation.ts'
import { E2E_CHAT, E2E_MODEL, E2E_PROVIDER, glmKeyFromCredentialStore, message as baseMessage, settings as baseSettings } from './e2e-harness.ts'
import type { InboundMessage } from '../src/types.ts'

/** One business-API request the fake 灯塔-7 server received. */
export interface BizRequest {
  /** Request path with query string. */
  path: string
  /** Monotonic arrival order within the server's lifetime. */
  order: number
}

/** The fake 灯塔-7 business API plus everything it recorded. */
export interface FakeBizApi {
  server: Server
  port: number
  /** Every received request path, in arrival order. */
  requests: BizRequest[]
  close(): Promise<void>
}

/**
 * Start the fake 灯塔-7 business API the Skill's S2/S3/S5 call: /asset and
 * /rule receipt as queries (RCPT-Q-*), /publish receipts as the sole side
 * effect (RCPT-P-*). Listens on an ephemeral port so parallel e2e files never
 * contend for the Skill's literal 4317.
 * @returns the recording fake API with its actual port.
 */
export function startFakeBizApi(): Promise<FakeBizApi> {
  const requests: BizRequest[] = []
  const server = createServer((req, res) => {
    const path = req.url ?? '/'
    requests.push({ path, order: requests.length })
    res.setHeader('content-type', 'application/json; charset=utf-8')
    if (path.startsWith('/asset')) {
      res.end(JSON.stringify({ ok: true, receipt: 'RCPT-Q-A4317', asset: { id: 'RELAY-B7', name: '主中继天线阵', zone: 'C环区', owner: '值班长·林澈', level: '一级' } }))
    } else if (path.startsWith('/rule')) {
      res.end(JSON.stringify({ ok: true, receipt: 'RCPT-Q-R8123', rules: [{ id: 'R-77', type: '电源波动', level: '高', action: '切换备用供电并通知动力舱' }] }))
    } else if (path.startsWith('/publish')) {
      res.end(JSON.stringify({ ok: true, receipt: 'RCPT-P-9001', alreadyPublished: false }))
    } else {
      res.statusCode = 404
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        server,
        port,
        requests,
        close: () => new Promise<void>((resolveClose) => {
          server.close(() => { resolveClose() })
        }),
      })
    })
  })
}

/** One inbound chat message bound to the skill e2e chat identity. */
export function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return baseMessage(overrides)
}

/**
 * The admitted alert-triage Skill body, read from the repository's project
 * skill root — the explicit-injection path the POC plan accepts without an
 * additional skill-tool call. The body's literal business port is repointed
 * at this run's fake API so parallel files never contend for one port.
 * @param port - the fake business API's actual port.
 * @returns the full SKILL.md text with the port substituted.
 */
export async function skillBody(port: number): Promise<string> {
  const raw = await readFile('.agents/skills/alert-triage/SKILL.md', 'utf8')
  return raw.replaceAll('localhost:4317', `localhost:${String(port)}`)
}

/** Everything a mounted skill e2e case exposes. */
export interface SkillE2EHarness {
  ctx: Context
  subject: ConversationRouter
  reply: Mock<(messageId: string, content: { kind: string; text?: string }) => Promise<void>>
  replyFile: Mock<(messageId: string, file: { name: string; path: string }) => Promise<void>>
  events(): readonly SessionEvent[]
  settled(count: number): Promise<void>
}

/**
 * Mount the skill e2e composition over one workspace directory: real loop,
 * GLM model, fs + bash tools; stubbed presets, persistence, Feishu senders.
 * @param workdir - fixture workspace the router's sessions work in.
 * @returns the harness; the caller owns disposal via `ctx.fiber.dispose()`.
 */
export async function mountSkillE2E(workdir: string): Promise<SkillE2EHarness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { personaPrefix: '你是灯塔-7 深空中继站的值班研判员。' },
  })
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(ToolFs)
  await ctx.plugin(AgentLoop, { agents: [] })
  const glmKey = glmKeyFromCredentialStore()
  if (glmKey === undefined) throw new Error('GLM key unavailable: skill e2e requires the local dsh credential store to hold GLM_API_KEY')
  await ctx.plugin(LlmPiAi, {
    providers: {
      [E2E_PROVIDER]: {
        displayName: 'GLM (skill e2e)',
        apiKeyEnv: 'GLM_API_KEY',
        api: 'anthropic-messages',
        baseURL: 'https://open.bigmodel.cn/api/anthropic',
        models: [{ id: E2E_MODEL, name: E2E_MODEL }],
      },
    },
  })
  ctx.provide('credentials', {
    resolve: vi.fn(async (ref: string) => ref === 'GLM_API_KEY' ? { value: glmKey } : undefined),
  })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(LocalBashExecutor, { cwd: workdir, timeoutMs: 30_000 })
  await ctx.plugin(ToolBash)

  const reply = vi.fn(async (_messageId: string, _content: { kind: string; text?: string }) => {})
  const replyFile = vi.fn(async (_messageId: string, _file: { name: string; path: string }) => {})
  const replyCard = vi.fn(async (_messageId: string, _card: Record<string, unknown>) => {})
  const fetchResource = vi.fn(async (): Promise<AsyncIterable<Uint8Array>> => {
    throw new Error('attachments are not part of the skill cases')
  })

  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: E2E_PROVIDER, model: E2E_MODEL }) })
  ctx.provide('permissionPresets', { resolve: vi.fn(), set: vi.fn() })
  ctx.provide('agentPresets', {
    resolve: vi.fn(async (id: string) => ({ id })),
    standingKeyFor: vi.fn(async () => {}),
    mount: vi.fn(async () => {}),
  })
  ctx.provide('workspaceRegistry', {
    create: vi.fn(async () => ({
      path: workdir,
      attachSession: vi.fn(async () => {}),
      detachSession: vi.fn(async () => {}),
    })),
  })
  ctx.provide('sessionTitle', { rename: vi.fn() })
  ctx.provide('sessionPersistence', {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ append: async (_events: unknown) => {}, close: async () => {} })),
  })
  ctx.provide('attachments', {
    saveFileStream: vi.fn(async ({ name }: { data: AsyncIterable<Uint8Array>; name: string }): Promise<FileAttachmentRef> => ({
      attachmentId: brandString<AttachmentId>(`att_${name}`),
      name,
      bytes: 0,
    })),
  })

  const subject = new ConversationRouter(
    ctx,
    { workspacePath: workdir, agentPreset: 'standard', permissionPreset: 'read-only' },
    () => baseSettings(),
    reply,
    replyFile,
    fetchResource,
    replyCard,
  )

  return {
    ctx,
    subject,
    reply,
    replyFile,
    events: () => {
      const agent = ctx.agents.get(sessionIdForChat(E2E_CHAT))
      return agent === undefined ? [] : agent.session.snapshotEvents()
    },
    settled: (count: number) => vi.waitFor(() => {
      expect(reply, `router settled ${String(count)} replies`).toHaveBeenCalledTimes(count)
    }, { timeout: 400_000, interval: 2_000 }),
  }
}
