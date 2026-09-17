/** Transport edges: the outbound WSS long connection and the inbound webhook route. */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { LarkSdk } from './lark.ts'
import { normalizeEventData } from './ingress.ts'
import type { CardAction, CardActionResponse } from './interaction.ts'
import { parseCardAction } from './interaction.ts'
import { createFileReplySender, createReplySender, type FileReplySender, type ReplySender } from './reply.ts'
import { createReactionSender, type ReactionSender } from './reaction.ts'
import { createTopicOpener, type TopicOpener } from './topic.ts'
import { createResourceFetcher, type ResourceFetcher } from './resource.ts'
import type { ConversationRouter } from './conversation.ts'
import type { FeishuSettings } from './config.ts'
import type { InteractionBridge } from './interaction.ts'

/** The event type this package handles. */
const MESSAGE_EVENT_TYPE = 'im.message.receive_v1'
/** The card-action callback type, delivered as one event frame on the long connection. */
const CARD_ACTION_EVENT_TYPE = 'card.action.trigger'
/** Sentinel a registered handler returns so a verified delivery is distinguishable from a rejected one. */
const HANDLER_OK = 'ok'

/**
 * The card-action dispatch step both ingress paths share: validate one
 * callback body, resolve the interaction it matches, and answer with the
 * response that refreshes the card. The HTTP route wraps it in the SDK's
 * card handler; the long-connection dispatcher returns it straight, and the
 * SDK relays the return value to the platform either way.
 * @param dispatch - resolves one admitted card action into its refresh response.
 * @returns the handler both ingress paths register.
 */
function cardActionHandler(dispatch: (action: CardAction) => CardActionResponse): (data: unknown) => CardActionResponse {
  return (data) => {
    const action = parseCardAction(data)
    // A malformed body still answers successfully: an empty response keeps
    // the card unchanged instead of failing a click the platform retried.
    return action === undefined ? {} : dispatch(action)
  }
}

/** One running transport edge: teardown plus the senders its credentials serve. */
export interface TransportEdge {
  stop(): void
  /** Replies sent through this edge's app credentials. */
  reply: ReplySender
  /** Thinking-indicator reactions sent through the same credentials. */
  reactions: ReactionSender
  /** Topic opening sent through the same credentials. */
  topics: TopicOpener
  /** File replies uploaded and sent through this edge's app credentials. */
  replyFile: FileReplySender
  /** Attachment downloads served through this edge's app credentials. */
  fetchResource: ResourceFetcher
}

/** The WebServer slice the webhook edge registers its route on. */
export interface WebServerRouteRegistrar {
  /**
   * Register one route.
   * @param route - exact or prefix route with its handler.
   * @returns the route disposer.
   */
  register(route: WebRoute): () => void
}

/** Resolved Feishu app credentials for one edge start. */
export interface AppCredentials {
  readonly appId: string
  readonly appSecret: string
}

/**
 * Resolve the app credentials a transport edge authenticates with. Literal
 * fields win over credential references, matching the web-search provider.
 * @param ctx - plugin context carrying the credentials seam.
 * @param settings - the currently authoritative settings section.
 * @returns non-empty app id and secret.
 * @throws when neither literal nor referenced credential supplies both values.
 */
export async function resolveAppCredentials(
  ctx: Context,
  settings: FeishuSettings,
): Promise<AppCredentials> {
  const appId = settings.appId !== undefined && settings.appId !== ''
    ? settings.appId
    : (await ctx.credentials.resolve(credentialRef(settings.appIdEnv)))?.value
  const appSecret = settings.appSecret !== undefined && settings.appSecret !== ''
    ? settings.appSecret
    : (await ctx.credentials.resolve(credentialRef(settings.appSecretEnv)))?.value
  if (appId === undefined || appId === '' || appSecret === undefined || appSecret === '') {
    throw new Error(`feishu: app credentials are unavailable (app id ref ${settings.appIdEnv}, app secret ref ${settings.appSecretEnv})`)
  }
  return { appId, appSecret }
}

/** Register the shared message handler on one dispatcher. */
function registerMessageHandler(router: ConversationRouter, dispatcher: ReturnType<LarkSdk['createDispatcher']>): void {
  dispatcher.register({
    [MESSAGE_EVENT_TYPE]: (data: unknown) => {
      const message = normalizeEventData(data)
      if (message !== undefined) router.accept(message)
      return HANDLER_OK
    },
  })
}

/**
 * Start the outbound long-connection edge. The SDK owns heartbeat and
 * reconnect; disposal closes the client without touching its reconnect loop.
 * Card callbacks configured for long-connection delivery arrive here as
 * `card.action.trigger` event frames; the handler's return value is relayed
 * to the platform as the callback response, so the card refreshes in place.
 * @param ctx - plugin context for lifecycle logging.
 * @param sdk - the Lark SDK construction surface.
 * @param settings - the currently authoritative settings section.
 * @param credentials - resolved app credentials.
 * @param router - the conversation router events feed into.
 * @param dispatch - resolves one admitted card action into its refresh response.
 * @returns the edge; stop closes the connection.
 */
export function startWebsocketEdge(
  ctx: Context,
  sdk: LarkSdk,
  settings: FeishuSettings,
  credentials: AppCredentials,
  router: ConversationRouter,
  dispatch: (action: CardAction) => CardActionResponse,
): TransportEdge {
  const dispatcher = sdk.createDispatcher({})
  registerMessageHandler(router, dispatcher)
  dispatcher.register({ [CARD_ACTION_EVENT_TYPE]: cardActionHandler(dispatch) })
  const client = sdk.createWsClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: settings.domain,
  })
  void client.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
    ctx.logger.error(`feishu: long connection failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  const api = sdk.createApiClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: settings.domain,
  })
  return {
    stop: () => {
      client.close()
    },
    reply: createReplySender(api),
    reactions: createReactionSender(api),
    topics: createTopicOpener(api),
    replyFile: createFileReplySender(api),
    fetchResource: createResourceFetcher(api),
  }
}

/** Webhook responses are empty or plain text, sent exactly once. */
function respond(response: ServerResponse, status: number, message?: string, contentType?: string): void {
  if (message === undefined) {
    response.writeHead(status)
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': contentType ?? 'text/plain; charset=utf-8' })
  response.end(message)
}

/** Whether Content-Type names JSON. */
function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false
  const [mediaType, ...parameters] = value.split(';').map(part => part.trim())
  return mediaType?.toLowerCase() === 'application/json' && parameters.length <= 1
}

/**
 * Enforce the webhook request preconditions and read the bounded JSON body.
 * @param request - the incoming request.
 * @param maxBytes - positive raw body ceiling.
 * @returns the decoded body of one JSON POST.
 * @throws {WebhookHttpError} 405 for non-POST, 415 for non-JSON, 413 when over the ceiling.
 */
async function requireJsonPostBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  if (request.method !== 'POST') {
    throw new WebhookHttpError(405, 'method not allowed; use POST')
  }
  if (!isJsonContentType(request.headers['content-type'])) {
    throw new WebhookHttpError(415, 'content type must be application/json')
  }
  return readBoundedUtf8Body(request, maxBytes)
}

/**
 * Read one request body as UTF-8 text under a byte ceiling.
 * @param request - the incoming request.
 * @param maxBytes - positive raw body ceiling.
 * @returns the decoded body.
 * @throws {WebhookHttpError} 413 when the body exceeds the ceiling.
 */
async function readBoundedUtf8Body(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of request) {
    received += (chunk as Buffer).byteLength
    if (received > maxBytes) throw new WebhookHttpError(413, 'request body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One webhook error carrying its HTTP status. */
class WebhookHttpError extends Error {
  /**
   * @param status - HTTP status to answer with.
   * @param message - plain-text response body.
   */
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * Start the inbound webhook edge: one exact route on the injected WebServer,
 * answering Feishu's URL challenge and dispatching verified events.
 * @param ctx - plugin context carrying the WebServer.
 * @param sdk - the Lark SDK construction surface.
 * @param settings - the currently authoritative settings section.
 * @param router - the conversation router events feed into.
 * @returns the edge; stop unregisters the route.
 * @throws when webhook credentials cannot be resolved.
 */
export async function startWebhookEdge(
  ctx: Context,
  sdk: LarkSdk,
  settings: FeishuSettings,
  webServer: WebServerRouteRegistrar | undefined,
  router: ConversationRouter,
): Promise<TransportEdge> {
  // webServer is an optional composition service resolved by the caller through
  // `ctx.inject`; the settings validate hook refuses a webhook section without
  // it, and this start path fails equally loud.
  if (webServer === undefined) {
    throw new Error('feishu: webhook transport requires a webServer service in the composition')
  }
  const credentials = await resolveAppCredentials(ctx, settings)
  const verificationToken = (await ctx.credentials.resolve(credentialRef(settings.verificationTokenEnv)))?.value ?? ''
  const encryptKey = (await ctx.credentials.resolve(credentialRef(settings.encryptKeyEnv)))?.value ?? ''
  const dispatcher = sdk.createDispatcher({
    verificationToken,
    encryptKey,
  })
  registerMessageHandler(router, dispatcher)
  const route: WebRoute = {
    kind: 'exact',
    path: settings.path,
    handler: async (request, response) => {
      try {
        const body = await requireJsonPostBody(request, settings.maxBodyBytes)
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          throw new WebhookHttpError(400, 'request body is not valid JSON')
        }
        // The SDK dispatcher reads signature headers off the payload's prototype,
        // mirroring the adapter SDK middleware builds.
        const data: unknown = Object.assign(Object.create({ headers: request.headers }), parsed)
        try {
          const { isChallenge, challenge } = sdk.generateChallenge(data, encryptKey)
          if (isChallenge) {
            respond(response, 200, JSON.stringify(challenge), 'application/json')
            return
          }
        } catch {
          // generateChallenge throws on an encrypted challenge body without a key.
          throw new WebhookHttpError(400, 'challenge cannot be decrypted without an encrypt key')
        }
        const result = await dispatcher.invoke(data)
        if (result !== HANDLER_OK) {
          // invoke returns undefined when signature verification rejected the body.
          throw new WebhookHttpError(401, 'event verification failed')
        }
        respond(response, 200)
      } catch (error: unknown) {
        if (error instanceof WebhookHttpError) {
          if (error.status === 405) response.setHeader('allow', 'POST')
          respond(response, error.status, error.message)
          return
        }
        ctx.logger.warn('feishu: webhook request failed')
        respond(response, 503, 'feishu webhook ingress is unavailable')
      }
    },
  }
  const unregister = webServer.register(route)
  const api = sdk.createApiClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain: settings.domain,
  })
  return {
    stop: unregister,
    reply: createReplySender(api),
    reactions: createReactionSender(api),
    topics: createTopicOpener(api),
    replyFile: createFileReplySender(api),
    fetchResource: createResourceFetcher(api),
  }
}

/**
 * Serialized swap engine for one lifecycle-managed resource: `reconfigure`
 * runs builds one at a time, each build returning the stop handle of the
 * resource it started, and `dispose` stops the active handle; a build a
 * disposed engine still awaited stops its own result.
 */
class SwapEngine {
  private current: (() => void) | undefined
  private chain: Promise<void> = Promise.resolve()
  private disposed = false

  /**
   * @param ctx - plugin context for lifecycle logging.
   * @param label - the resource name failure logs carry.
   */
  constructor(private readonly ctx: Context, private readonly label: string) {}

  /** Swap the active resource for one `build` produces. */
  reconfigure(build: () => Promise<() => void>): void {
    if (this.disposed) return
    this.chain = this.chain
      .then(async () => {
        this.current?.()
        this.current = undefined
        const stop = await build()
        if (this.disposed) {
          stop()
          return
        }
        this.current = stop
      })
      .catch((error: unknown) => {
        this.ctx.logger.error(`feishu: ${this.label} failed to start: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /** Stop the active resource; a swap already in flight stops its own result. */
  dispose(): void {
    this.disposed = true
    this.current?.()
    this.current = undefined
  }
}

/**
 * Owns the single active transport edge. Settings commits call
 * {@link EdgeController.reconfigure}; edge starts are serialized so a rapid
 * settings change never leaves two edges live.
 */
export class EdgeController {
  private readonly swaps: SwapEngine

  /**
   * @param ctx - plugin context for lifecycle logging.
   * @param sdk - the Lark SDK construction surface.
   * @param router - the conversation router edges feed and reply through.
   * @param settings - thunk returning the currently authoritative settings section.
   * @param webServer - thunk returning the optionally composed WebServer registrar.
   * @param interactions - the bridge whose interaction cards reply through the active edge.
   */
  constructor(
    private readonly ctx: Context,
    private readonly sdk: LarkSdk,
    private readonly router: ConversationRouter,
    private readonly settings: () => FeishuSettings,
    private readonly webServer: () => WebServerRouteRegistrar | undefined,
    private readonly interactions: InteractionBridge,
  ) {
    this.swaps = new SwapEngine(ctx, 'transport edge')
  }

  /** Swap the active edge for one built from the current settings. */
  reconfigure(): void {
    this.swaps.reconfigure(async () => {
      const settings = this.settings()
      if (settings.transport === 'webhook') {
        const edge = await startWebhookEdge(this.ctx, this.sdk, settings, this.webServer(), this.router)
        this.activate(edge)
        return () => {
          edge.stop()
        }
      }
      const credentials = await resolveAppCredentials(this.ctx, settings)
      const edge = startWebsocketEdge(this.ctx, this.sdk, settings, credentials, this.router, action => this.interactions.dispatch(action))
      this.activate(edge)
      return () => {
        edge.stop()
      }
    })
  }

  /** Stop the active edge; a swap already in flight stops its own result. */
  dispose(): void {
    this.swaps.dispose()
  }

  private activate(edge: TransportEdge): void {
    this.router.setReplySender(edge.reply)
    this.router.setReactionSender(edge.reactions)
    this.router.setTopicOpener(edge.topics)
    this.router.setFileReplySender(edge.replyFile)
    this.router.setResourceFetcher(edge.fetchResource)
    this.interactions.setReplySender(edge.reply)
  }
}

/** One running card-callback edge: the route serving interactive cards' actions. */
export interface CardCallbackEdge {
  stop(): void
}

/**
 * Start the card-action callback edge: one exact route under the webhook
 * path answering Feishu's card callback verification and dispatching
 * verified actions. This route serves deployments whose Feishu console
 * posts card callbacks to a request address; the long-connection console
 * mode delivers them over the websocket edge instead.
 * @param ctx - plugin context carrying the credentials seam.
 * @param sdk - the Lark SDK construction surface.
 * @param settings - the currently authoritative settings section.
 * @param webServer - the composed WebServer registrar.
 * @param dispatch - resolves one admitted action and returns the response that refreshes the card.
 * @returns the edge; stop unregisters the route.
 */
export async function startCardCallbackEdge(
  ctx: Context,
  sdk: LarkSdk,
  settings: FeishuSettings,
  webServer: WebServerRouteRegistrar,
  dispatch: (action: CardAction) => CardActionResponse,
): Promise<CardCallbackEdge> {
  const verificationToken = (await ctx.credentials.resolve(credentialRef(settings.verificationTokenEnv)))?.value ?? ''
  const encryptKey = (await ctx.credentials.resolve(credentialRef(settings.encryptKeyEnv)))?.value ?? ''
  const handler = sdk.createCardActionHandler({ verificationToken, encryptKey }, cardActionHandler(dispatch))
  const route: WebRoute = {
    kind: 'exact',
    path: `${settings.path}/card`,
    handler: async (request, response) => {
      try {
        const body = await requireJsonPostBody(request, settings.maxBodyBytes)
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          throw new WebhookHttpError(400, 'request body is not valid JSON')
        }
        // The SDK handler reads signature headers off the payload's prototype,
        // mirroring the event dispatcher's webhook contract.
        const data: unknown = Object.assign(Object.create({ headers: request.headers }), parsed)
        try {
          const { isChallenge, challenge } = sdk.generateChallenge(data, encryptKey)
          if (isChallenge) {
            respond(response, 200, JSON.stringify(challenge), 'application/json')
            return
          }
        } catch {
          throw new WebhookHttpError(400, 'challenge cannot be decrypted without an encrypt key')
        }
        const result = await handler.invoke(data)
        if (result === undefined) {
          // invoke returns undefined when signature verification rejected the body.
          throw new WebhookHttpError(401, 'card action verification failed')
        }
        respond(response, 200, JSON.stringify(result), 'application/json')
      } catch (error: unknown) {
        if (error instanceof WebhookHttpError) {
          if (error.status === 405) response.setHeader('allow', 'POST')
          respond(response, error.status, error.message)
          return
        }
        ctx.logger.warn('feishu: card callback request failed')
        respond(response, 503, 'feishu card callback ingress is unavailable')
      }
    },
  }
  return { stop: webServer.register(route) }
}

/**
 * Owns the card-callback route. Settings commits and credential updates call
 * {@link CardCallbackController.reconfigure}; registrations are serialized
 * after the transport edge swaps so a rapid change never leaves two routes.
 */
export class CardCallbackController {
  private readonly swaps: SwapEngine

  /**
   * @param ctx - plugin context for lifecycle logging.
   * @param sdk - the Lark SDK construction surface.
   * @param settings - thunk returning the currently authoritative settings section.
   * @param webServer - thunk returning the composed WebServer registrar.
   * @param dispatch - resolves one admitted card action into its refresh response.
   */
  constructor(
    private readonly ctx: Context,
    private readonly sdk: LarkSdk,
    private readonly settings: () => FeishuSettings,
    private readonly webServer: () => WebServerRouteRegistrar | undefined,
    private readonly dispatch: (action: CardAction) => CardActionResponse,
  ) {
    this.swaps = new SwapEngine(ctx, 'card callback route')
  }

  /** Rebuild the route from the current settings; disabled settings unregister it. */
  reconfigure(): void {
    this.swaps.reconfigure(async () => {
      const settings = this.settings()
      if (!settings.interactionCards.enabled) return () => {}
      const webServer = this.webServer()
      // Card callbacks configured for long-connection delivery never touch
      // this route; without a WebServer only that console mode works, and
      // the warn names the missing piece for an HTTP-mode deployment.
      if (webServer === undefined) {
        this.ctx.logger.warn('feishu: no webServer composed; interactive cards serve long-connection card callbacks only')
        return () => {}
      }
      const edge = await startCardCallbackEdge(this.ctx, this.sdk, settings, webServer, this.dispatch)
      return () => {
        edge.stop()
      }
    })
  }

  /** Stop the active route; a swap already in flight stops its own result. */
  dispose(): void {
    this.swaps.dispose()
  }
}
