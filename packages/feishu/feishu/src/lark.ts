/** The Lark SDK surface this package depends on, plus its one production binding. */

import type { Readable } from 'node:stream'
import { Client, Domain, EventDispatcher, LoggerLevel, WSClient, generateChallenge as sdkGenerateChallenge } from '@larksuiteoapi/node-sdk'

/** Outcome of one outbound Feishu API call; the SDK resolves instead of throwing on API errors. */
export interface LarkResponse {
  /** Feishu business code; 0 is success. */
  readonly code?: number | undefined
  /** Feishu error message when `code` is non-zero. */
  readonly msg?: string | undefined
}

/** The `im.v1.message` resource of a Lark API client. */
export interface LarkMessageResource {
  /**
   * Reply to one message.
   * @param params - path message identity plus text content.
   * @returns the Feishu API response envelope.
   */
  reply(params: {
    path: { message_id: string }
    data: { msg_type: 'text'; content: string }
  }): Promise<LarkResponse>
}

/** The `im.v1.messageResource` resource of a Lark API client. */
export interface LarkMessageResourceApi {
  /**
   * Download one message's media resource. Unlike reply, HTTP failures throw
   * rather than resolving a code envelope.
   * @param params - download type plus message and resource identity.
   * @returns the download wrapper; the stream is consumable once.
   */
  get(params: {
    params: { type: 'image' | 'file' }
    path: { message_id: string; file_key: string }
  }): Promise<{ getReadableStream(): Readable }>
}

/** The slice of a Lark API client this package uses. */
export interface LarkApiClient {
  readonly im: {
    readonly v1: {
      readonly message: LarkMessageResource
      readonly messageResource: LarkMessageResourceApi
    }
  }
}

/** Lark SDK `EventDispatcher`: registered handlers receive flattened event payloads. */
export interface LarkDispatcher {
  /**
   * Register event handlers by event type.
   * @param handlers - map from event type to handler; sync and async returns both apply.
   * @returns the same dispatcher for chaining.
   */
  register(handlers: Record<string, (data: unknown) => unknown>): unknown
  /**
   * Validate, parse, and dispatch one webhook request body.
   * @param data - parsed request body carrying request headers on its prototype.
   * @returns the registered handler's return value, when one ran.
   */
  invoke(data: unknown): Promise<unknown>
}

/** Lark SDK `WSClient`: one outbound long connection delivering events. */
export interface LarkWsClient {
  /**
   * Connect and start receiving events; resolves after the first handshake succeeds.
   * @param params - the dispatcher events route to.
   */
  start(params: { eventDispatcher: LarkDispatcher }): Promise<void>
  /**
   * Close the connection and stop reconnecting.
   * @param params - `force` terminates without waiting for the peer.
   */
  close(params?: { force?: boolean }): void
}

/** Construction surface of the Lark SDK, injectable so tests never touch the network. */
export interface LarkSdk {
  /**
   * Create an API client for outbound calls.
   * @param params - app credentials, domain, and log level.
   * @returns the API client.
   */
  createApiClient(params: { appId: string; appSecret: string; domain: string }): LarkApiClient
  /**
   * Create a long-connection client.
   * @param params - app credentials, domain, and log level.
   * @returns the long-connection client.
   */
  createWsClient(params: { appId: string; appSecret: string; domain: string }): LarkWsClient
  /**
   * Create an event dispatcher.
   * @param params - webhook verification credentials; both empty on the long-connection edge.
   * @returns the dispatcher.
   */
  createDispatcher(params: { verificationToken?: string; encryptKey?: string }): LarkDispatcher
  /**
   * Answer one `url_verification` request.
   * @param data - parsed request body.
   * @param encryptKey - the configured encrypt key, when the request is encrypted.
   * @returns whether the request is a challenge, plus the challenge answer payload.
   */
  generateChallenge(data: unknown, encryptKey: string): { isChallenge: boolean; challenge: { challenge: unknown } }
}

/** Map a settings domain value onto the SDK's accepted domain parameter. */
function sdkDomainOf(domain: string): Domain | string {
  if (domain === 'feishu') return Domain.Feishu
  if (domain === 'lark') return Domain.Lark
  return domain
}

const loggerLevel = Number(process.env.DSH_FEISHU_SDK_LOG_LEVEL ?? LoggerLevel.warn)

/** The production binding over `@larksuiteoapi/node-sdk`. */
export const larkSdk: LarkSdk = {
  createApiClient: ({ appId, appSecret, domain }) => new Client({
    appId,
    appSecret,
    domain: sdkDomainOf(domain),
    loggerLevel,
  }),
  createWsClient: ({ appId, appSecret, domain }) => new WSClient({
    appId,
    appSecret,
    domain: sdkDomainOf(domain),
    loggerLevel,
  }),
  createDispatcher: ({ verificationToken, encryptKey }) => new EventDispatcher({
    verificationToken: verificationToken ?? '',
    encryptKey: encryptKey ?? '',
    loggerLevel,
  }),
  generateChallenge: (data, encryptKey) => {
    if (data === null || typeof data !== 'object') return { isChallenge: false, challenge: { challenge: undefined } }
    // generateChallenge throws when the body is encrypted but the key is missing;
    // the webhook handler turns that into a 400.
    return sdkGenerateChallenge(data, { encryptKey })
  },
}
