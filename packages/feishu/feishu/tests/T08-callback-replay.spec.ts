/**
 * T08 (POC 用例「回调/重放」): 校验信息、重复有效事件 → 伪造拒绝；合法重复只受理一次。
 * Cover: the webhook edge rejects forged (unverified) deliveries before the
 * router ever sees them, and a replayed legitimate event produces exactly one
 * accepted turn end-to-end.
 */

import type { ServerResponse, IncomingMessage } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { LarkApiClient, LarkSdk } from '../src/lark.ts'
import { startWebhookEdge } from '../src/edges.ts'
import { sessionIdForChat } from '../src/conversation.ts'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { reply, resetStubs, router, settings as baseSettings, stubbedContext as routerContext, followups } from './poc-stubs.ts'

/** Every field of a settings section, writable. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** One legitimate im.message.receive_v1 envelope. */
function eventEnvelope(messageId: string): string {
  return JSON.stringify({
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1' },
    event: {
      message: { message_id: messageId, chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: `{"text":"${messageId}"}` },
    },
  })
}

/** The single dispatcher instance verifyingSdk hands out. */
let dispatcher: { register: (handlers: Record<string, (data: unknown) => unknown>) => void; invoke: Mock } | undefined

/** Fake dispatcher whose invoke gate we control: verified pass-through, forged reject. */
function verifyingSdk(): LarkSdk {
  return {
    createApiClient: () => ({}) as unknown as LarkApiClient,
    createWsClient: () => { throw new Error('unused') },
    createDispatcher: () => {
      dispatcher ??= (() => {
        const handlers = new Map<string, (data: unknown) => unknown>()
        return {
          register: (registered: Record<string, (data: unknown) => unknown>) => {
            for (const [type, handler] of Object.entries(registered)) handlers.set(type, handler)
          },
          invoke: vi.fn(async (data: unknown) => {
            const record = data as { header?: { event_type?: string }; event?: unknown }
            const handler = handlers.get(record?.header?.event_type ?? '')
            return handler === undefined ? undefined : handler({ ...record?.header, ...(record?.event as object) })
          }),
        }
      })()
      return dispatcher
    },
    generateChallenge: () => ({ isChallenge: false, challenge: undefined }),
  } as unknown as LarkSdk
}

/** One fake request with a JSON body. */
function fakeRequest(body: string): IncomingMessage {
  const chunks = [Buffer.from(body)]
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

/** One fake server response capturing status. */
function fakeResponse(): { response: ServerResponse; status(): number | undefined } {
  const captured: { status?: number } = {}
  const response = {
    setHeader: () => {},
    writeHead: (status: number) => {
      captured.status = status
    },
    end: () => {},
  } as unknown as ServerResponse
  return { response, status: () => captured.status }
}

let composedContexts: Context[] = []

/** Compose the webhook edge over a real router; returns the HTTP handler and invoke gate. */
async function compose() {
  const ctx = new Context()
  composedContexts.push(ctx)
  ctx.provide('credentials', { resolve: vi.fn(async () => ({ value: 'stub' })) })
  const routes: { handler: unknown }[] = []
  ctx.provide('webServer', { register: (route: { handler: unknown }) => { routes.push(route); return () => {} } })

  const live: Mutable<ReturnType<typeof baseSettings>> = { ...baseSettings(), transport: 'webhook' as const }
  const sdk = verifyingSdk()
  const routerCtx = routerContext()
  composedContexts.push(routerCtx)
  const subject = router(routerCtx, live)
  const edge = await startWebhookEdge(ctx, sdk, live, ctx.get('webServer'), subject)
  const invokeGate = dispatcher?.invoke
  expect(invokeGate).toBeDefined()
  const handler = routes[0]!.handler as (request: IncomingMessage, response: ServerResponse) => Promise<void>
  return { handler, invokeGate: invokeGate!, stop: () => { edge.stop() } }
}

afterEach(() => {
  resetStubs()
  composedContexts.forEach(context => void context.fiber.dispose())
  composedContexts = []
  dispatcher = undefined
})

describe('T08 回调/重放', () => {
  it('伪造事件（验真失败）被拒绝且进不了业务层', async () => {
    const { handler, invokeGate, stop } = await compose()
    // 首次调用本身被标记为未通过验真
    invokeGate.mockImplementationOnce(async () => undefined)
    const forged = fakeResponse()
    await handler(fakeRequest(eventEnvelope('om_forged')), forged.response)
    expect(forged.status()).toBe(401)
    // 未产生任何业务提交
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(followups.get(sessionIdForChat('oc_1'))).toBeUndefined()
    expect(reply).not.toHaveBeenCalled()
    stop()
  })

  it('合法事件重放：HTTP 都应答 200，但业务只受理一次', async () => {
    const { handler, stop } = await compose()
    const first = fakeResponse()
    await handler(fakeRequest(eventEnvelope('om_legit')), first.response)
    expect(first.status()).toBe(200)
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(reply).toHaveBeenCalledOnce()

    // Feishu 在未及时收到 200 时会重放同一事件；transport 层照常应答，业务层只受理一次
    const replay = fakeResponse()
    await handler(fakeRequest(eventEnvelope('om_legit')), replay.response)
    expect(replay.status()).toBe(200)
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(reply).toHaveBeenCalledOnce()
    expect(followups.get(sessionIdForChat('oc_1'))).toHaveBeenCalledOnce()
    stop()
  })

  it('同一窗口内不同事件ID各自独立受理', async () => {
    const { handler, stop } = await compose()
    for (const id of ['om_a', 'om_a', 'om_b']) {
      const response = fakeResponse()
      await handler(fakeRequest(eventEnvelope(id)), response.response)
      expect(response.status()).toBe(200)
    }
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(followups.get(sessionIdForChat('oc_1'))).toHaveBeenCalledTimes(2)
    stop()
  })
})
