/** Real Loader composition: WebServer + plugin on the webhook transport, driven over real HTTP. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as FeishuPlugin from '../src/index.ts'

/** Followup calls observed by the stub agent registry. */
const followups: { prompt: string; sourceKind: string }[] = []
/** The created session ids, in order. */
const createdSessionIds: string[] = []

let root: string | undefined
let context: Context | undefined

/** Compose one real WebServer plus the plugin over stubbed core services. */
async function compose(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'dsh-feishu-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: fixture-dependencies',
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-feishu'",
    '  config:',
    '    transport: webhook',
    '    workspacePath: /tmp/dsh-feishu-loader-workspace',
    '    agentPreset: standard',
    '    permissionPreset: read-only',
    '',
  ].join('\n'))

  const dependencies = {
    name: 'fixture-dependencies',
    apply(ctx: Context) {
      ctx.provide('agents', {
        create: async ({ sessionId }: { sessionId: string }) => {
          createdSessionIds.push(sessionId)
          return {
            agent: {
              session: { id: sessionId, events: [], header: {} },
              followup: (message: { content: { type: string; text: string }[]; source: { kind: string } }) => {
                followups.push({ prompt: message.content[0]!.text, sourceKind: message.source.kind })
              },
              // Never settle the turn: this composition pins ingress behavior,
              // not settlement, so no reply ever leaves toward the network.
              whenIdle: () => new Promise<void>(() => {}),
            },
            dispose: async () => {},
          }
        },
        resume: async () => {
          throw new Error('unexpected resume in loader composition')
        },
        get: () => undefined,
      })
      ctx.provide('agentPresets', {
        resolve: async (id: string) => ({ id }),
        standingKeyFor: async () => {},
        mount: async () => {},
      })
      ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) })
      ctx.provide('permissionPresets', { resolve: () => {}, set: () => {} })
      ctx.provide('workspaceRegistry', {
        create: async () => ({ path: '/tmp/dsh-feishu-loader-workspace', attachSession: async () => {}, detachSession: async () => {} }),
      })
      ctx.provide('sessionTitle', { rename: () => {} })
      ctx.provide('sessionPersistence', { list: async () => [] })
      ctx.provide('attachments', {
        // This composition pins text-message ingress; an attachment download
        // reaching the real network would be a defect, so the stub refuses loud.
        saveFileStream: async () => {
          throw new Error('unexpected attachment save in loader composition')
        },
      })
      ctx.provide('credentials', {
        resolve: async (ref: unknown) => {
          const values: Record<string, string> = {
            DSH_FEISHU_APP_ID: 'cli_loader',
            DSH_FEISHU_APP_SECRET: 'loader-secret',
            // Empty webhook credentials keep this composition unencrypted and
            // unsigned, like a deployment that relies on route secrecy.
            DSH_FEISHU_VERIFICATION_TOKEN: '',
            DSH_FEISHU_ENCRYPT_KEY: '',
          }
          const value = values[String(ref)] ?? ''
          return { value }
        },
      })
    },
  }

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['fixture-dependencies', dependencies],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-feishu', FeishuPlugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  expect([...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  followups.length = 0
  createdSessionIds.length = 0
})

/** One `im.message.receive_v1` v2 event body. */
function eventBody(messageId: string): string {
  return JSON.stringify({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1', token: 'loader-secret' },
    event: {
      message: {
        message_id: messageId,
        chat_id: 'oc_loader',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello from loader' }),
      },
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_loader' } },
    },
  })
}

describe('real Loader composition', () => {
  it('registers the webhook route, answers the challenge, and admits one chat event once', { timeout: 60_000 }, async () => {
    await compose()
    const port = (context!.get('webServer') as unknown as { port: number }).port

    const challenge = await fetch(`http://127.0.0.1:${String(port)}/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'loader-challenge' }),
    })
    expect(challenge.status).toBe(200)
    await expect(challenge.json()).resolves.toEqual({ challenge: 'loader-challenge' })

    const first = await fetch(`http://127.0.0.1:${String(port)}/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: eventBody('om_loader_1'),
    })
    expect(first.status).toBe(200)

    // A retry delivery of the same message identity is deduplicated.
    const retry = await fetch(`http://127.0.0.1:${String(port)}/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: eventBody('om_loader_1'),
    })
    expect(retry.status).toBe(200)

    expect(createdSessionIds.length).toBe(1)
    await vi.waitFor(() => { expect(followups.length).toBe(1) })
    expect(followups[0]!.sourceKind).toBe('feishu')
    expect(followups[0]!.prompt).toContain('untrusted external input')
    expect(followups[0]!.prompt.endsWith('hello from loader')).toBe(true)
  })
})
