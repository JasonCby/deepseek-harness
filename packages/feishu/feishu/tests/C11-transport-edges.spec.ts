/** C11: transport-edge and EdgeController tests over a fake Lark SDK binding. */

import { Context } from '@deepseek-ai/cordis'
import type { ServerResponse, IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { EdgeController, startWebhookEdge } from '../src/edges.ts'
import type { LarkApiClient, LarkSdk } from '../src/lark.ts'
import { ConversationRouter } from '../src/conversation.ts'
import type { FeishuSettings } from '../src/config.ts'

/** Every field of a settings section, writable for live-edit tests. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** One mutable settings section the controller reads live. */
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
    failureNotice: 'failed',
    dedupCapacity: 64,
  }
}

/** Everything the fake SDK recorded. */
interface SdkTrace {
  sdk: LarkSdk
  wsClients: { start: Mock; close: Mock }[]
  apiClients: { reply: Mock; resourceGet: Mock; fileCreate: Mock }[]
  dispatchers: { register: Mock; invoke: Mock }[]
  registeredRoutes: { kind: string; path: string; handler: unknown }[]
  router: { accept: Mock; setReplySender: Mock; setFileReplySender: Mock; setResourceFetcher: Mock }
}

/** Build the fake SDK binding plus its trace. */
function fakeSdk(): SdkTrace {
  const wsClients: SdkTrace['wsClients'] = []
  const apiClients: SdkTrace['apiClients'] = []
  const dispatchers: SdkTrace['dispatchers'] = []
  const trace: SdkTrace = {
    wsClients,
    apiClients,
    dispatchers,
    registeredRoutes: [],
    router: { accept: vi.fn(), setReplySender: vi.fn(), setFileReplySender: vi.fn(), setResourceFetcher: vi.fn() },
    sdk: {
      createApiClient: () => {
        const client = {
          reply: vi.fn(async () => ({ code: 0 })),
          resourceGet: vi.fn(async () => ({ getReadableStream: () => { throw new Error('unused in edge tests') } })),
          fileCreate: vi.fn(async () => ({ file_key: 'fk_edge' })),
        }
        apiClients.push(client)
        return client as unknown as LarkApiClient
      },
      createWsClient: () => {
        const client = {
          start: vi.fn(async () => {}),
          close: vi.fn(),
        }
        wsClients.push(client)
        return client
      },
      createDispatcher: () => {
        const handlers = new Map<string, (data: unknown) => unknown>()
        const dispatcher = {
          register: vi.fn((registered: Record<string, (data: unknown) => unknown>) => {
            for (const [type, handler] of Object.entries(registered)) handlers.set(type, handler)
          }),
          invoke: vi.fn(async (data: unknown) => {
            const record = data as { header?: { event_type?: string }; event?: unknown }
            const type = record?.header?.event_type
            const handler = type === undefined ? undefined : handlers.get(type)
            if (handler === undefined) return undefined
            // Mirror the SDK's flatten step: header and event merge into one payload.
            return handler({ ...record?.header, ...(record?.event as object) })
          }),
        }
        dispatchers.push(dispatcher)
        return dispatcher
      },
      generateChallenge: (data: unknown) => {
        const record = data as { type?: string; challenge?: unknown }
        return {
          isChallenge: record?.type === 'url_verification',
          challenge: { challenge: record?.challenge },
        }
      },
    },
  }
  return trace
}

/** Build a context providing the credentials and (optionally) webServer seams. */
function stubbedContext(withWebServer: boolean): Context {
  const ctx = new Context()
  ctx.provide('credentials', {
    resolve: vi.fn(async () => ({ value: 'stub' })),
  })
  if (withWebServer) {
    ctx.provide('webServer', {
      register: (route: { kind: string; path: string; handler: unknown }) => {
        stubbedContext.routes.push(route)
        return () => {
          const index = stubbedContext.routes.indexOf(route)
          if (index >= 0) stubbedContext.routes.splice(index, 1)
        }
      },
    })
  }
  return ctx
}
stubbedContext.routes = [] as { kind: string; path: string; handler: unknown }[]

/** Build a conversation-router stub the edges feed. */
function routerStub(trace: SdkTrace): ConversationRouter {
  return trace.router as unknown as ConversationRouter
}

afterEach(() => {
  stubbedContext.routes.length = 0
})

describe('EdgeController', () => {
  it('starts the websocket edge and wires its reply and download senders', async () => {
    const trace = fakeSdk()
    const ctx = stubbedContext(false)
    const live = settings()
    const controller = new EdgeController(ctx, trace.sdk, routerStub(trace), () => live, () => ctx.get('webServer'))
    controller.reconfigure()
    await vi.waitFor(() => { expect(trace.wsClients[0]?.start).toHaveBeenCalledOnce() })
    expect(trace.router.setReplySender).toHaveBeenCalledOnce()
    expect(trace.router.setFileReplySender).toHaveBeenCalledOnce()
    expect(trace.router.setResourceFetcher).toHaveBeenCalledOnce()
    const registered = trace.dispatchers[0]?.register.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(registered !== undefined && 'im.message.receive_v1' in registered).toBe(true)
    controller.dispose()
    expect(trace.wsClients[0]?.close).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('swaps to the webhook edge and back on live settings changes', async () => {
    const trace = fakeSdk()
    const ctx = stubbedContext(true)
    const live = settings()
    const controller = new EdgeController(ctx, trace.sdk, routerStub(trace), () => live, () => ctx.get('webServer'))
    controller.reconfigure()
    await vi.waitFor(() => { expect(trace.wsClients[0]?.start).toHaveBeenCalledOnce() })
    live.transport = 'webhook'
    controller.reconfigure()
    await vi.waitFor(() => { expect(stubbedContext.routes.length).toBe(1) })
    expect(trace.wsClients[0]?.close).toHaveBeenCalledOnce()
    expect(stubbedContext.routes[0]?.path).toBe('/feishu')
    live.transport = 'websocket'
    controller.reconfigure()
    await vi.waitFor(() => { expect(stubbedContext.routes.length).toBe(0) })
    expect(trace.wsClients[1]?.start).toHaveBeenCalledOnce()
    controller.dispose()
    await ctx.fiber.dispose()
  })

  it('logs loudly when credentials are unresolvable and keeps no edge', async () => {
    const trace = fakeSdk()
    const ctx = new Context()
    const errors: unknown[] = []
    ctx.provide('credentials', {
      resolve: vi.fn(async () => undefined),
    })
    const originalError = ctx.logger.error
    ctx.logger.error = (...args: unknown[]) => {
      errors.push(args)
    }
    const controller = new EdgeController(ctx, trace.sdk, routerStub(trace), () => settings(), () => undefined)
    controller.reconfigure()
    await vi.waitFor(() => { expect(errors.length).toBe(1) })
    expect(trace.wsClients.length).toBe(0)
    ctx.logger.error = originalError
    await ctx.fiber.dispose()
  })
})

/** One fake server request over a body string. */
function fakeRequest(method: string, body: string, headers: Record<string, string> = {}): IncomingMessage {
  const chunks = [Buffer.from(body)]
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

/** One fake server response capturing status and body. */
function fakeResponse(): { response: ServerResponse; status(): number | undefined; body(): string } {
  const captured: { status?: number; body?: string | undefined; headers: Record<string, unknown> } = { headers: {} }
  const response = {
    setHeader: (name: string, value: unknown) => {
      captured.headers[name] = value
    },
    writeHead: (status: number) => {
      captured.status = status
    },
    end: (body?: string) => {
      captured.body = body
    },
  } as unknown as ServerResponse
  return {
    response,
    status: () => captured.status,
    body: () => captured.body ?? '',
  }
}

describe('webhook edge handler', () => {
  /** Start the webhook edge and return its registered route handler. */
  async function webhookHandler(trace: SdkTrace, live: FeishuSettings) {
    const ctx = stubbedContext(true)
    const edge = await startWebhookEdge(ctx, trace.sdk, live, ctx.get('webServer'), routerStub(trace))
    const route = stubbedContext.routes[0]
    expect(route).toBeDefined()
    return {
      handler: route!.handler as (request: IncomingMessage, response: ServerResponse) => Promise<void>,
      stop: () => { edge.stop() },
      ctx,
    }
  }

  it('answers the URL challenge with the echo payload', async () => {
    const trace = fakeSdk()
    const { handler, stop, ctx } = await webhookHandler(trace, settings())
    const captured = fakeResponse()
    await handler(
      fakeRequest('POST', JSON.stringify({ type: 'url_verification', challenge: 'echo-me' }), { 'content-type': 'application/json' }),
      captured.response,
    )
    expect(captured.status()).toBe(200)
    expect(JSON.parse(captured.body())).toEqual({ challenge: 'echo-me' })
    stop()
    await ctx.fiber.dispose()
  })

  it('accepts one verified event into the router and answers retries 200', async () => {
    const trace = fakeSdk()
    const { handler, stop, ctx } = await webhookHandler(trace, settings())
    const captured = fakeResponse()
    const event = JSON.stringify({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1' },
      event: {
        message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: '{"text":"hi"}' },
      },
    })
    await handler(fakeRequest('POST', event, { 'content-type': 'application/json' }), captured.response)
    expect(captured.status()).toBe(200)
    expect(trace.router.accept).toHaveBeenCalledOnce()
    // Retry deduplication is ConversationRouter behavior; the edge only owes
    // the caller an acknowledgement.
    const retry = fakeResponse()
    await handler(fakeRequest('POST', event, { 'content-type': 'application/json' }), retry.response)
    expect(retry.status()).toBe(200)
    stop()
    await ctx.fiber.dispose()
  })

  it('rejects unverified events and malformed requests', async () => {
    const trace = fakeSdk()
    const { handler, stop, ctx } = await webhookHandler(trace, settings())
    trace.dispatchers[0]!.invoke.mockResolvedValueOnce(undefined)
    const unverified = fakeResponse()
    await handler(fakeRequest('POST', '{}', { 'content-type': 'application/json' }), unverified.response)
    expect(unverified.status()).toBe(401)

    const wrongMethod = fakeResponse()
    await handler(fakeRequest('GET', '', {}), wrongMethod.response)
    expect(wrongMethod.status()).toBe(405)

    const wrongType = fakeResponse()
    await handler(fakeRequest('POST', '{}', { 'content-type': 'text/plain' }), wrongType.response)
    expect(wrongType.status()).toBe(415)

    const badJson = fakeResponse()
    await handler(fakeRequest('POST', 'not json', { 'content-type': 'application/json' }), badJson.response)
    expect(badJson.status()).toBe(400)
    stop()
    await ctx.fiber.dispose()
  })

  it('rejects an oversized body', async () => {
    const trace = fakeSdk()
    const live = { ...settings(), maxBodyBytes: 4 }
    const { handler, stop, ctx } = await webhookHandler(trace, live)
    const oversized = fakeResponse()
    await handler(fakeRequest('POST', 'x'.repeat(10), { 'content-type': 'application/json' }), oversized.response)
    expect(oversized.status()).toBe(413)
    stop()
    await ctx.fiber.dispose()
  })
})
