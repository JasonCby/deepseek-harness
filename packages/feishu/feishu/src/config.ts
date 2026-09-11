/** Plugin configuration and the UI-editable settings section derived from it. */

import z from '@deepseek-ai/schemastery'
import type { FeishuTransport, ReplyForm } from './types.ts'

/** Default credential reference naming the Feishu app id. */
export const DEFAULT_APP_ID_ENV = 'DSH_FEISHU_APP_ID'
/** Default credential reference naming the Feishu app secret. */
export const DEFAULT_APP_SECRET_ENV = 'DSH_FEISHU_APP_SECRET'
/** Default credential reference naming the webhook verification token. */
export const DEFAULT_VERIFICATION_TOKEN_ENV = 'DSH_FEISHU_VERIFICATION_TOKEN'
/** Default credential reference naming the webhook encrypt key. */
export const DEFAULT_ENCRYPT_KEY_ENV = 'DSH_FEISHU_ENCRYPT_KEY'

/** Settings namespace this plugin registers for UI editing. */
export const FEISHU_SETTINGS_NAMESPACE = 'feishu'

/** Fields editable through the settings surface and hot-applied on change. */
export interface FeishuSettings {
  /** Ingress transport: outbound WSS long connection or inbound webhook route. */
  readonly transport: FeishuTransport
  /**
   * Open-platform domain: the `feishu` or `lark` shorthand, or a
   * self-hosted deployment's complete API origin (`https://…/open-apis` host).
   */
  readonly domain: string
  /** Literal app id; prefer {@link FeishuSettings.appIdEnv} so configuration files stay shareable. */
  readonly appId?: string
  /** Credential reference resolved for the app id. */
  readonly appIdEnv: string
  /** Literal app secret; prefer {@link FeishuSettings.appSecretEnv} so no secret enters configuration files. */
  readonly appSecret?: string
  /** Credential reference resolved for the app secret. */
  readonly appSecretEnv: string
  /** Credential reference resolved for the webhook verification token (webhook transport). */
  readonly verificationTokenEnv: string
  /** Credential reference resolved for the webhook encrypt key (webhook transport). */
  readonly encryptKeyEnv: string
  /** Absolute route path the webhook transport registers. */
  readonly path: string
  /** Positive raw body ceiling in bytes (webhook transport). */
  readonly maxBodyBytes: number
  /** Chats the bot answers; empty answers every chat that reaches it. */
  readonly allowChatIds: string[]
  /** In groups, answer only messages whose mention list is non-empty. */
  readonly groupRequireMention: boolean
  /** Reply texts longer than this are truncated with an ellipsis marker. */
  readonly replyCharLimit: number
  /** Form settled replies take: plain text or a single markdown card. */
  readonly replyForm: ReplyForm
  /** Card header title when {@link FeishuSettings.replyForm} is `card`. */
  readonly cardTitle: string
  /** Emoji key bracketing admitted turns as the thinking indicator; empty disables the indicator. */
  readonly thinkingEmoji: string
  /** Text replied when message processing fails before a reply exists. */
  readonly failureNotice: string
  /** Maximum remembered message identities for retry deduplication. */
  readonly dedupCapacity: number
}

/** Full plugin configuration: the settings section plus deployment-only fields. */
export interface Config extends FeishuSettings {
  /** Existing local directory sessions work in. */
  readonly workspacePath: string
  /** Agent composition mounted for each chat session. */
  readonly agentPreset: string
  /** Sandbox and approval preset applied to each chat session. */
  readonly permissionPreset: string
}

const settingsFields = {
  transport: z.union(['websocket', 'webhook'] as const).default('websocket'),
  domain: z.string().default('feishu'),
  appId: z.string(),
  appIdEnv: z.string().role('credential-ref').default(DEFAULT_APP_ID_ENV),
  appSecret: z.string().role('secret'),
  appSecretEnv: z.string().role('credential-ref').default(DEFAULT_APP_SECRET_ENV),
  verificationTokenEnv: z.string().role('credential-ref').default(DEFAULT_VERIFICATION_TOKEN_ENV),
  encryptKeyEnv: z.string().role('credential-ref').default(DEFAULT_ENCRYPT_KEY_ENV),
  path: z.string().default('/feishu'),
  maxBodyBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(65536),
  allowChatIds: z.array(z.string()).default([]),
  groupRequireMention: z.boolean().default(true),
  replyCharLimit: z.number().step(1).min(200).default(4000),
  replyForm: z.union(['text', 'card', 'auto'] as const).default('auto'),
  cardTitle: z.string().default('DSH'),
  thinkingEmoji: z.string().default('Typing'),
  failureNotice: z.string().default('Sorry, something went wrong while handling this message.'),
  dedupCapacity: z.number().step(1).min(16).default(1024),
}

/** Schema of the UI-editable settings section (namespace {@link FEISHU_SETTINGS_NAMESPACE}). */
export const SettingsConfig: z<FeishuSettings> = z.object(settingsFields)

/** Schema of the full composition configuration. */
export const Config: z<Config> = z.object({
  ...settingsFields,
  workspacePath: z.string().required(),
  agentPreset: z.string().default('standard'),
  permissionPreset: z.string().default('read-only'),
})

/** Project one full configuration into its settings-section subset. */
export function settingsEntryOf(config: Config): FeishuSettings {
  return {
    transport: config.transport,
    domain: config.domain,
    ...config.appId === undefined ? {} : { appId: config.appId },
    appIdEnv: config.appIdEnv,
    ...config.appSecret === undefined ? {} : { appSecret: config.appSecret },
    appSecretEnv: config.appSecretEnv,
    verificationTokenEnv: config.verificationTokenEnv,
    encryptKeyEnv: config.encryptKeyEnv,
    path: config.path,
    maxBodyBytes: config.maxBodyBytes,
    allowChatIds: config.allowChatIds,
    groupRequireMention: config.groupRequireMention,
    replyCharLimit: config.replyCharLimit,
    replyForm: config.replyForm,
    cardTitle: config.cardTitle,
    thinkingEmoji: config.thinkingEmoji,
    failureNotice: config.failureNotice,
    dedupCapacity: config.dedupCapacity,
  }
}

/**
 * Validate settings facts Schemastery cannot express.
 * @param value - the resolved settings section, schema-valid by construction.
 * @throws when a field combination cannot serve events.
 */
export function assertSettings(value: FeishuSettings): void {
  if (!value.path.startsWith('/') || value.path === '/' || value.path.endsWith('/')
    || value.path.includes('?') || value.path.includes('#')) {
    throw new Error('feishu path must be an absolute non-root pathname without a trailing slash, query, or fragment')
  }
  const domain = value.domain
  const shorthand = domain === 'feishu' || domain === 'lark'
  if (!shorthand && (!/^https?:\/\/.+/.test(domain) || domain.endsWith('/') || domain !== domain.trim())) {
    throw new Error('feishu domain must be the feishu or lark shorthand or a trimmed absolute http(s) origin of a self-hosted deployment')
  }
  if (value.failureNotice.trim() === '') {
    throw new Error('feishu failureNotice must be non-empty')
  }
  if (value.cardTitle.trim() === '') {
    throw new Error('feishu cardTitle must be non-empty')
  }
  if (value.thinkingEmoji.trim() !== value.thinkingEmoji) {
    throw new Error('feishu thinkingEmoji must be a trimmed emoji key; use an empty string to disable the thinking indicator')
  }
  if (value.allowChatIds.some(id => id.trim() !== id || id === '')) {
    throw new Error('feishu allowChatIds entries must be non-empty trimmed strings')
  }
}

/** Validate composition-only facts Schemastery cannot express. */
export function assertConfig(config: Config): void {
  assertSettings(config)
  if (config.workspacePath.trim() === '') {
    throw new Error('feishu workspacePath must be non-empty')
  }
}
