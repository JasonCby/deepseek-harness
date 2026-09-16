/** Transport-edge and EdgeController tests over a fake Lark SDK binding. */

import { Context } from '@deepseek-ai/cordis'
import type { ServerResponse, IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { CardCallbackController, EdgeController, startCardCallbackEdge, startWebhookEdge } from '../src/edges.ts'
import type { LarkSdk } from '../src/lark.ts'
import { ConversationRouter } from '../src/conversation.ts'
import { renderMarkdownCard } from '../src/card.ts'
import type { ReplySender } from '../src/reply.ts'
import type { ReactionSender } from '../src/reaction.ts'
import type { TopicOpener } from '../src/topic.ts'
import type { FeishuSettings } from '../src/config.ts'
import type { InteractionBridge } from '../src/interaction.ts'
import type { InboundMessage } from '../src/types.ts'

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
    replyInThread: false,
    cardTemplates: [],
    replyCharLimit: 4000,
    replyForm: 'text',
    cardTitle: 'DSH',
    cardLocale: 'zh_cn',
    thinkingEmoji: 'Typing',
    failureNotice: 'failed',
    dedupCapacity: 64,
    interactionCards: {
      enabled: false,
      approval: { approveLabel: 'Approve', rejectLabel: 'Reject' },
      question: { title: 'Please answer', submitLabel: 'Submit' },
    },
  }
}

/** One `im.v1.message.reply` call the fake API client records. */
type ReplyCall = {
  path: { message_id: string }
  data: { msg_type: 'text' | 'interactive'; content: string }
}

/** One `im.v1.messageReaction.create` call the fake API client records. */
type ReactionCreateCall = {
  path: { message_id: string }
  data: { reaction_type: { emoji_type: string } }
}

/** Everything the fake SDK recorded. */
interface SdkTrace {
  sdk: LarkSdk
  wsClients: { start: Mock; close: Mock }[]
  apiClients: {
    reply: Mock<(params: ReplyCall) => Promise<{ code: number }>>
    reactionCreate: Mock<(params: ReactionCreateCall) => Promise<{ code: number; data?: { reaction_id?: string } }>>
    reactionDelete: Mock<(params: { path: { message_id: string; reaction_id: string } }) => Promise<{ code: number }>>
    resourceGet: Mock
    fileCreate: Mock
  }[]
  dispatchers: { register: Mock; invoke: Mock }[]
  cardHandlers: { invoke: Mock; refuse: () => void }[]
  registeredRoutes: { kind: string; path: string; handler: unknown }[]
  router: {
    accept: Mock<(message: InboundMessage) => void>
    setReplySender: Mock<(sender: ReplySender) => void>
    setReactionSender: Mock<(sender: ReactionSender) => void>
    setTopicOpener: Mock<(opener: TopicOpener) => void>
    setFileReplySender: Mock
    setResourceFetcher: Mock
  }
}

/** Build the fake SDK binding plus its trace. */
function fakeSdk(): SdkTrace {
  const wsClients: SdkTrace['wsClients'] = []
  const apiClients: SdkTrace['apiClients'] = []
  const dispatchers: SdkTrace['dispatchers'] = []
  const cardHandlers: SdkTrace['cardHandlers'] = []
  const trace: SdkTrace = {
    wsClients,
    apiClients,
    dispatchers,
    cardHandlers,
    registeredRoutes: [],
    router: {
      accept: vi.fn((_message: InboundMessage) => {}),
      setReplySender: vi.fn((_sender: ReplySender) => {}),
      setReactionSender: vi.fn((_sender: ReactionSender) => {}),
      setTopicOpener: vi.fn((_opener: TopicOpener) => {}),
      setFileReplySender: vi.fn(),
      setResourceFetcher: vi.fn(),
    },
    sdk: {
      createApiClient: () => {
        const reply = vi.fn(async (_params: ReplyCall) => ({ code: 0 }))
        const reactionCreate = vi.fn(async (_params: ReactionCreateCall) => ({ code: 0, data: { reaction_id: 're_1' } }))
        const reactionDelete = vi.fn(async (_params: { path: { message_id: string; reaction_id: string } }) => ({ code: 0 }))
        const resourceGet = vi.fn(async () => ({ getReadableStream: () => { throw new Error('unused in edge tests') } }))
        const fileCreate = vi.fn(async () => ({ file_key: 'fk_edge' }))
        apiClients.push({ reply, reactionCreate, reactionDelete, resourceGet, fileCreate })
        return {
          im: {
            v1: {
              message: { reply },
              messageReaction: { create: reactionCreate, delete: reactionDelete },
              messageResource: { get: resourceGet },
              file: { create: fileCreate },
            },
          },
        }
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
      createCardActionHandler: (_params: unknown, handler: (data: unknown) => unknown) => {
        let refuse = false
        const cardHandler = {
          refuse: () => {
            refuse = true
          },
          invoke: vi.fn(async (data: unknown) => {
            if (refuse) return undefined
            // Mirror the SDK's flatten step: header and event merge into one payload.
            const record = data as { header?: Record<string, unknown>; event?: Record<string, unknown> }
            return handler({ ...record?.header, ...(record?.event as object) })
          }),
        }
        cardHandlers.push(cardHandler)
        return cardHandler
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

/** Build an interaction-bridge stub the edges update senders and dispatch through. */
function bridgeStub(): InteractionBridge & { dispatch: ReturnType<typeof vi.fn> } {
  return { setReplySender: vi.fn(), dispatch: vi.fn(() => ({ toast: { type: 'info', content: 'stub' } })) } as unknown as InteractionBridge & { dispatch: ReturnType<typeof vi.fn> }
}

afterEach(() => {
  stubbedContext.routes.length = 0
})

describe('EdgeController', () => {
  it('registers card.action.trigger on the long connection and answers with the refresh directive', async () => {
    const trace = fakeSdk()
    const live = settings()
    const ctx = stubbedContext(false)
    const bridge = bridgeStub()
    const controller = new EdgeController(ctx, trace.sdk, routerStub(trace), () => live, () => undefined, bridge)
    controller.reconfigure()
    await vi.waitFor(() => { expect(trace.wsClients[0]?.start).toHaveBeenCalledOnce() })
    const result: unknown = await trace.dispatchers[0]!.invoke({
      schema: '2.0',
      header: { event_type: 'card.action.trigger' },
      event: { operator: { open_id: 'ou_1' }, action: { tag: 'button', value: { interactionId: 'fi-1', outcome: 'approved' } } },
    })
    expect(bridge.dispatch).toHaveBeenCalledOnce()
    expect(result).toEqual({ toast: { type: 'info', content: 'stub' } })
    controller.dispose()
    await ctx.fiber.dispose()
  })

  it('starts the websocket edge and wires its reply and download senders', async () => {
    const trace = fakeSdk()
    const ctx = stubbedContext(false)
    const live = settings()
    const controller = new EdgeController(ctx, trace.sdk, routerStub(trace), () => live, () => ctx.get('webServer'), bridgeStub())
    controller.reconfigure()
    await vi.waitFor(() => { expect(trace.wsClients[0]?.start).toHaveBeenCalledOnce() })
    expect(trace.router.setReplySender).toHaveBeenCalledOnce()
    expect(trace.router.setReactionSender).toHaveBeenCalledOnce()
    expect(trace.router.setTopicOpener).toHaveBeenCalledOnce()
    expect(trace.router.setFileReplySender).toHaveBeenCalledOnce()
    expect(trace.router.setResourceFetcher).toHaveBeenCalledOnce()
    const registered = trace.dispatchers[0]?.register.mock.calls[0]?.[0] as Record<string, unknown> | undefined
    expect(registered !== undefined && 'im.message.receive_v1' in registered).toBe(true)
    controller.dispose()
    expect(trace.wsClients[0]?.close).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('delivers card payloads as interactive replies', async () => {
    const trace = fakeSdk()
    const ctx = stubbedContext(false)
    const controller = new EdgeController(ctx, trace.sdk, routerStub(trace), () => settings(), () => undefined, bridgeStub())
    controller.reconfigure()
    await vi.waitFor(() => { expect(trace.router.setReplySender).toHaveBeenCalledOnce() })
    const sender = trace.router.setReplySender.mock.calls[0]?.[0]
    if (sender === undefined) throw new Error('sender was not wired')
    await sender('om_1', { kind: 'card', card: renderMarkdownCard('done', 'Ops') })
    const call = trace.apiClients[0]?.reply.mock.calls[0]?.[0]
    expect(call?.data.msg_type).toBe('interactive')
    expect(JSON.parse(call?.data.content ?? '{}')).toMatchObject({ header: { title: { content: 'Ops' } } })
    controller.dispose()
    await ctx.fiber.dispose()
  })

  it('delivers template payloads as template messages', async () => {
    const trace = fakeSdk()
    const ctx = stubbedContext(false)
    const controller = new EdgeController(ctx, trace.sdk, routerStub(trace), () => settings(), () => undefined, bridgeStub())
    controller.reconfigure()
    await vi.waitFor(() => { expect(trace.router.setReplySender).toHaveBeenCalledOnce() })
    const sender = trace.router.setReplySender.mock.calls[0]?.[0]
    if (sender === undefined) throw new Error('sender was not wired')
    await sender('om_1', { kind: 'template', templateId: 'AAq1', variables: { a: 'b' } })
    const call = trace.apiClients[0]?.reply.mock.calls[0]?.[0]
    expect(call?.data.msg_type).toBe('interactive')
    expect(JSON.parse(call?.data.content ?? '{}')).toEqual({ type: 'template', data: { template_id: 'AAq1', template_variable: { a: 'b' } } })
    controller.dispose()
    await ctx.fiber.dispose()
  })

  it('swaps to the webhook edge and back on live settings changes', async () => {
    const trace = fakeSdk()
    const ctx = stubbedContext(true)
    let live = settings()
    const controller = new EdgeController(ctx, trace.sdk, routerStub(trace), () => live, () => ctx.get('webServer'), bridgeStub())
    controller.reconfigure()
    await vi.waitFor(() => { expect(trace.wsClients[0]?.start).toHaveBeenCalledOnce() })
    live = { ...live, transport: 'webhook' }
    controller.reconfigure()
    await vi.waitFor(() => { expect(stubbedContext.routes.length).toBe(1) })
    expect(trace.wsClients[0]?.close).toHaveBeenCalledOnce()
    expect(stubbedContext.routes[0]?.path).toBe('/feishu')
    live = { ...live, transport: 'websocket' }
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
    const controller = new EdgeController(ctx, trace.sdk, routerStub(trace), () => settings(), () => undefined, bridgeStub())
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

describe('card callback edge', () => {
  /** Start the card callback edge and return its registered route handler. */
  async function cardRoute(trace: SdkTrace, live: FeishuSettings) {
    const ctx = stubbedContext(true)
    const dispatch = vi.fn((): { card: { type: 'raw'; data: unknown } } => ({ card: { type: 'raw', data: { elements: [] } } }))
    const edge = await startCardCallbackEdge(ctx, trace.sdk, live, ctx.get('webServer')!, dispatch)
    const route = stubbedContext.routes.at(-1)
    expect(route?.path).toBe(`${live.path}/card`)
    return {
      handler: route!.handler as (request: IncomingMessage, response: ServerResponse) => Promise<void>,
      dispatch,
      stop: () => { edge.stop() },
      ctx,
    }
  }

  it('registers under the webhook path and answers the challenge', async () => {
    const trace = fakeSdk()
    const { handler, stop, ctx } = await cardRoute(trace, settings())
    const captured = fakeResponse()
    await handler(fakeRequest('POST', JSON.stringify({ type: 'url_verification', challenge: 'echo-me' }), { 'content-type': 'application/json' }), captured.response)
    expect(captured.status()).toBe(200)
    expect(JSON.parse(captured.body())).toEqual({ challenge: 'echo-me' })
    stop()
    await ctx.fiber.dispose()
  })

  it('dispatches one verified card action and answers with the refresh directive', async () => {
    const trace = fakeSdk()
    const { handler, dispatch, stop, ctx } = await cardRoute(trace, settings())
    const captured = fakeResponse()
    const action = JSON.stringify({
      schema: '2.0',
      header: { event_type: 'card.action.trigger' },
      event: { operator: { open_id: 'ou_1' }, action: { tag: 'button', value: { interactionId: 'fi-1', outcome: 'approved' } } },
    })
    await handler(fakeRequest('POST', action, { 'content-type': 'application/json' }), captured.response)
    expect(captured.status()).toBe(200)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(JSON.parse(captured.body())).toEqual({ card: { type: 'raw', data: { elements: [] } } })
    stop()
    await ctx.fiber.dispose()
  })

  it('rejects unverified, malformed, and wrong-method card requests', async () => {
    const trace = fakeSdk()
    const { handler, stop, ctx } = await cardRoute(trace, settings())
    trace.cardHandlers[0]!.refuse()
    const unverified = fakeResponse()
    await handler(fakeRequest('POST', '{}', { 'content-type': 'application/json' }), unverified.response)
    expect(unverified.status()).toBe(401)
    const malformed = fakeResponse()
    await handler(fakeRequest('POST', 'not json', { 'content-type': 'application/json' }), malformed.response)
    expect(malformed.status()).toBe(400)
    const wrongMethod = fakeResponse()
    await handler(fakeRequest('GET', '', { 'content-type': 'application/json' }), wrongMethod.response)
    expect(wrongMethod.status()).toBe(405)
    stop()
    await ctx.fiber.dispose()
  })
})

describe('CardCallbackController', () => {
  it('registers the route only while cards are enabled', async () => {
    const trace = fakeSdk()
    const live = settings()
    live.interactionCards = { ...live.interactionCards, enabled: true }
    const ctx = stubbedContext(true)
    const controller = new CardCallbackController(ctx, trace.sdk, () => live, () => ctx.get('webServer'), () => ({ toast: { type: 'info', content: 'x' } }))
    controller.reconfigure()
    await vi.waitFor(() => { expect(stubbedContext.routes.map(route => route.path)).toContain('/feishu/card') })
    live.interactionCards = { ...live.interactionCards, enabled: false }
    controller.reconfigure()
    await vi.waitFor(() => { expect(stubbedContext.routes.map(route => route.path)).not.toContain('/feishu/card') })
    controller.dispose()
    await ctx.fiber.dispose()
  })

  it('serves long-connection-only without a webServer and registers the route once one arrives', async () => {
    const trace = fakeSdk()
    const live = settings()
    live.interactionCards = { ...live.interactionCards, enabled: true }
    const ctx = stubbedContext(false)
    const logs: string[] = []
    ctx.logger.warn = (message: string) => { logs.push(message) }
    const controller = new CardCallbackController(ctx, trace.sdk, () => live, () => ctx.get('webServer'), () => ({ toast: { type: 'info', content: 'x' } }))
    controller.reconfigure()
    await vi.waitFor(() => { expect(logs.join('\n')).toMatch(/long-connection card callbacks only/) })
    expect(stubbedContext.routes.map(route => route.path)).not.toContain('/feishu/card')
    ctx.provide('webServer', {
      register: (route: { kind: string; path: string; handler: unknown }) => {
        stubbedContext.routes.push(route)
        return () => {
          const index = stubbedContext.routes.indexOf(route)
          if (index >= 0) stubbedContext.routes.splice(index, 1)
        }
      },
    })
    controller.reconfigure()
    await vi.waitFor(() => { expect(stubbedContext.routes.map(route => route.path)).toContain('/feishu/card') })
    controller.dispose()
    await ctx.fiber.dispose()
  })
})
