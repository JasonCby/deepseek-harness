/**
 * Shared e2e harness for the POC positive-path specs (U01/T01): a real
 * ConversationRouter driving a real AgentLoop with a real DeepSeek model and
 * real filesystem tools, while Feishu-facing senders and the router's
 * peripheral services stay behavioral stubs.
 * @module e2e-harness
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
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, vi, type Mock } from 'vitest'
import { ConversationRouter, sessionIdForChat } from '../src/conversation.ts'
import type { FeishuSettings } from '../src/config.ts'
import type { InboundAttachment, InboundMessage } from '../src/types.ts'

/** The GLM route the harness registers and routes every turn through. */
export const E2E_PROVIDER = 'glm'
export const E2E_MODEL = 'glm-5.3'

/**
 * Read the inline `GLM_API_KEY` reference out of the local dsh credential
 * store, the same record the running Feishu bot's glm route consumes.
 * @returns the key, or undefined when the store or the reference is absent.
 */
export function glmKeyFromCredentialStore(): string | undefined {
  try {
    const yaml = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = /^[ \t]*GLM_API_KEY:[ \t]*(\S+)[ \t]*$/m.exec(yaml)
    return match?.[1]
  } catch {
    return undefined
  }
}

/** The chat identity every e2e message shares, so turns land in one session. */
export const E2E_CHAT = 'oc_e2e'

/** One settings section; the dedup window spans one e2e suite run. */
export function settings(): FeishuSettings {
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
    messageId: 'om_e2e_1',
    chatId: E2E_CHAT,
    chatType: 'p2p',
    senderOpenId: 'ou_e2e',
    text: 'run the drill',
    attachments: [],
    mentioned: false,
    ...overrides,
  }
}

/** Everything a mounted harness exposes to one e2e case. */
export interface E2EHarness {
  ctx: Context
  subject: ConversationRouter
  reply: Mock<(messageId: string, text: string) => Promise<void>>
  replyFile: Mock<(messageId: string, file: { name: string; path: string }) => Promise<void>>
  /** The workspace every session's cwd resolves to; drill fixtures live here. */
  workdir: string
  /** Ordered session events of the chat's live agent, for tool-call evidence. */
  events(): SessionEvent[]
  /** Wait until the router settled `count` replies (one per finished turn). */
  settled(count: number): Promise<void>
}

/**
 * Mount the e2e composition over one workspace directory: real loop, model,
 * and fs tools; stubbed presets, persistence, and Feishu senders.
 * @param workdir - fixture workspace the router's sessions work in.
 * @returns the harness; the caller owns disposal via `ctx.fiber.dispose()`.
 */
export async function mountE2E(workdir: string): Promise<E2EHarness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { personaPrefix: '你是告警研判助手。严格依据用户提供的现场数据回答，不臆造。' },
  })
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  await ctx.plugin(ToolFs)
  await ctx.plugin(AgentLoop, { agents: [] })
  const glmKey = glmKeyFromCredentialStore()
  if (glmKey === undefined) throw new Error('GLM key unavailable: e2e requires the local dsh credential store to hold GLM_API_KEY')
  await ctx.plugin(LlmPiAi, {
    providers: {
      [E2E_PROVIDER]: {
        displayName: 'GLM (e2e)',
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

  const reply = vi.fn(async (_messageId: string, _text: string) => {})
  const replyFile = vi.fn(async (_messageId: string, _file: { name: string; path: string }) => {})
  const fetchResource = vi.fn(
    async (_messageId: string, _attachment: InboundAttachment): Promise<AsyncIterable<Uint8Array>> => {
      throw new Error('attachments are not part of these positive-path cases')
    },
  )

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
  // agent-loop writes every session through this seam when present; an
  // in-memory backend keeps the e2e durable-free while ConversationRouter's
  // list() answers that nothing persisted across harness restarts.
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
    () => settings(),
    reply,
    replyFile,
    fetchResource,
  )

  return {
    ctx,
    subject,
    reply,
    replyFile,
    workdir,
    events: () => {
      const agent = ctx.agents.get(sessionIdForChat(E2E_CHAT))
      return agent === undefined ? [] : agent.session.snapshotEvents()
    },
    settled: (count: number) => vi.waitFor(() => {
      expect(reply, `router settled ${String(count)} replies`).toHaveBeenCalledTimes(count)
    }, { timeout: 170_000, interval: 1_000 }),
  }
}

/**
 * Write the drill fixtures into one workspace: two correlated alerts, an asset
 * inventory, and a triage runbook with a deterministic correct answer.
 * @param workdir - fixture workspace root.
 */
export async function writeDrillFixtures(workdir: string): Promise<void> {
  await writeFile(`${workdir}/active_alerts.json`, JSON.stringify({
    alerts: [
      {
        alert_id: 'ALT-E2E-001',
        asset: 'prod-web-nginx-03',
        severity: 'P0',
        title: '生产 Nginx 节点 5xx 激增',
        occurred_at: '2026-09-14T13:20:00+08:00',
        metrics: { http_5xx_rate: '38.2%', p99_latency_ms: 4210, active_connections: 18200 },
        summary: 'prod-web-nginx-03 自 13:18 起 5xx 比例从 0.3% 升至 38.2%，疑似上游 prod-order-api 线程池耗尽引起级联超时。',
      },
      {
        alert_id: 'ALT-E2E-002',
        asset: 'prod-order-api',
        severity: 'P1',
        title: '订单服务线程池耗尽',
        occurred_at: '2026-09-14T13:16:00+08:00',
        metrics: { thread_pool_active: '200/200', queue_depth: 3400, gc_pause_ms_p95: 820 },
        summary: '订单服务线程池打满，队列积压 3400，早于 nginx 告警 2 分钟出现。',
      },
    ],
  }, null, 2))
  await writeFile(`${workdir}/asset_inventory.csv`, [
    'asset,owner_team,oncall_primary,oncall_backup,deploy_env',
    'prod-web-nginx-03,基础设施组,陈炳宇,王悦,生产',
    'prod-order-api,订单交易组,王悦,路畅,生产',
  ].join('\n'))
  await writeFile(`${workdir}/runbook.md`, [
    '# P0/P1 告警研判手册',
    '',
    '1. 核对告警时间线：上游故障应早于入口层告警；',
    '2. 判定根因资产：取 metrics 与时间线共同指向的服务；',
    '3. 处置：对根因服务执行扩容/限流，入口层无需单独重启；',
    '4. 通报：根因资产 owner_team 的 oncall_primary 为第一责任人；',
    '5. 恢复确认：5xx < 1% 且队列 < 100 持续 5 分钟后由第一责任人确认关单。',
  ].join('\n'))
}
