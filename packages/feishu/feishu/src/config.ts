/** Plugin configuration and the UI-editable settings section derived from it. */

import z from '@deepseek-ai/schemastery'
import type { CardTemplateEntry, TemplateVariableRule } from './template.ts'
import { resolveCardFormat } from './template.ts'
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
  /** Open one topic per main-stream message and answer inside it; topic messages always continue their topic. */
  readonly replyInThread: boolean
  /** Reply texts longer than this are truncated with an ellipsis marker. */
  readonly replyCharLimit: number
  /** Form settled replies take: plain text or a single markdown card. */
  readonly replyForm: ReplyForm
  /** Card header title when {@link FeishuSettings.replyForm} is `card`. */
  readonly cardTitle: string
  /** Builder multilingual key lifted to `elements`/`header` when a template card is a builder export. */
  readonly cardLocale: string
  /** Emoji key bracketing admitted turns as the thinking indicator; empty disables the indicator. */
  readonly thinkingEmoji: string
  /** Text replied when message processing fails before a reply exists. */
  readonly failureNotice: string
  /** Maximum remembered message identities for retry deduplication. */
  readonly dedupCapacity: number
  /** Card templates bound to the tool turns whose replies render them. */
  readonly cardTemplates: CardTemplateEntry[]
  /** Interactive approval and question cards, their callbacks, and their settled refreshes. */
  readonly interactionCards: InteractionCardsSettings
}

/** Style knobs of the interactive approval confirm cards. */
export interface ApprovalCardsSettings {
  /** Local card JSON 1.0 frame carrying `{{toolName}}`/`{{reason}}` placeholders; the button row is appended. */
  readonly pendingCard?: unknown
  /** Local card JSON 1.0 frame carrying `{{outcome}}`/`{{decidedBy}}` placeholders for the callback refresh. */
  readonly settledCard?: unknown
  /** Platform template the callback refresh updates the card with, instead of a local settled frame. */
  readonly settledTemplateId?: string
  /** Approve button label. */
  readonly approveLabel: string
  /** Reject button label. */
  readonly rejectLabel: string
}

/** Style knobs of the interactive ask-user form cards. */
export interface QuestionCardsSettings {
  /** Form card header title. */
  readonly title: string
  /** Form submit button label. */
  readonly submitLabel: string
  /** Local card JSON 1.0 frame carrying `{{outcome}}`/`{{decidedBy}}`/`{{summary}}` placeholders for the callback refresh. */
  readonly settledCard?: unknown
  /** Platform template the callback refresh updates the card with, instead of a local settled frame. */
  readonly settledTemplateId?: string
}

/** Interactive cards answering in-turn approval and user-question requests. */
export interface InteractionCardsSettings {
  /** Whether the bridge claims those requests with cards; disabled passes them to other channels. */
  readonly enabled: boolean
  /** Approval confirm card knobs. */
  readonly approval: ApprovalCardsSettings
  /** Ask-user form card knobs. */
  readonly question: QuestionCardsSettings
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

const templateVariable: z<TemplateVariableRule> = z.object({
  from: z.union(['context', 'tool-result'] as const),
  key: z.string(),
  path: z.string(),
  required: z.boolean().default(false),
  maxLength: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
})

const cardTemplate: z<CardTemplateEntry> = z.object({
  name: z.string(),
  bindTool: z.string(),
  workflowName: z.string(),
  templateId: z.string(),
  card: z.any(),
  variables: z.dict(templateVariable),
})

const approvalCards: z<ApprovalCardsSettings> = z.object({
  pendingCard: z.any(),
  settledCard: z.any(),
  settledTemplateId: z.string(),
  approveLabel: z.string().default('Approve'),
  rejectLabel: z.string().default('Reject'),
})

const questionCards: z<QuestionCardsSettings> = z.object({
  title: z.string().default('Please answer'),
  submitLabel: z.string().default('Submit'),
  settledCard: z.any(),
  settledTemplateId: z.string(),
})

const interactionCards: z<InteractionCardsSettings> = z.object({
  enabled: z.boolean().default(false),
  approval: approvalCards.default({ approveLabel: 'Approve', rejectLabel: 'Reject' }),
  question: questionCards.default({ title: 'Please answer', submitLabel: 'Submit' }),
})

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
  replyInThread: z.boolean().default(false),
  replyCharLimit: z.number().step(1).min(200).default(4000),
  replyForm: z.union(['text', 'card', 'auto'] as const).default('auto'),
  cardTitle: z.string().default('DSH'),
  cardLocale: z.string().default('zh_cn'),
  thinkingEmoji: z.string().default('Typing'),
  failureNotice: z.string().default('Sorry, something went wrong while handling this message.'),
  dedupCapacity: z.number().step(1).min(16).default(1024),
  cardTemplates: z.array(cardTemplate).default([]),
  interactionCards,
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
    replyInThread: config.replyInThread,
    replyCharLimit: config.replyCharLimit,
    replyForm: config.replyForm,
    cardTitle: config.cardTitle,
    cardLocale: config.cardLocale,
    thinkingEmoji: config.thinkingEmoji,
    failureNotice: config.failureNotice,
    dedupCapacity: config.dedupCapacity,
    cardTemplates: config.cardTemplates,
    interactionCards: config.interactionCards,
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
  if (value.cardLocale.trim() === '' || value.cardLocale !== value.cardLocale.trim()) {
    throw new Error('feishu cardLocale must be a non-empty trimmed builder multilingual key')
  }
  if (value.thinkingEmoji.trim() !== value.thinkingEmoji) {
    throw new Error('feishu thinkingEmoji must be a trimmed emoji key; use an empty string to disable the thinking indicator')
  }
  if (value.allowChatIds.some(id => id.trim() !== id || id === '')) {
    throw new Error('feishu allowChatIds entries must be non-empty trimmed strings')
  }
  const templateNames = new Set<string>()
  for (const template of value.cardTemplates) {
    if (template.name.trim() === '' || templateNames.has(template.name)) {
      throw new Error('feishu cardTemplates names must be non-empty and unique')
    }
    templateNames.add(template.name)
    if (template.bindTool.trim() === '') {
      throw new Error(`feishu cardTemplates entry "${template.name}" needs a non-empty bindTool`)
    }
    const hasTemplateId = template.templateId !== undefined && template.templateId !== ''
    if (hasTemplateId === (template.card !== undefined)) {
      throw new Error(`feishu cardTemplates entry "${template.name}" must carry exactly one of templateId or card`)
    }
    if (!hasTemplateId) {
      // Shape authority lives with the render pipeline: this accepts canonical
      // card JSON 1.0 and the builder's multilingual export, and rejects card
      // JSON 2.0 by name as long as no 'v2' dialect joins CardInputFormat.
      resolveCardFormat(template.card, value.cardLocale, `feishu cardTemplates entry "${template.name}" card`)
    }
    for (const [variable, rule] of Object.entries(template.variables)) {
      if (rule.from === 'context' && !['chatId', 'senderOpenId', 'threadId'].includes(rule.key ?? '')) {
        throw new Error(`feishu cardTemplates entry "${template.name}" variable "${variable}" needs a context key of chatId, senderOpenId, or threadId`)
      }
      if (rule.from === 'tool-result' && (rule.path ?? '').trim() === '') {
        throw new Error(`feishu cardTemplates entry "${template.name}" variable "${variable}" needs a non-empty tool-result path`)
      }
    }
  }
  const cards = value.interactionCards
  if (cards.approval.approveLabel.trim() === '' || cards.approval.rejectLabel.trim() === '') {
    throw new Error('feishu interactionCards approval labels must be non-empty')
  }
  if (cards.question.title.trim() === '' || cards.question.submitLabel.trim() === '') {
    throw new Error('feishu interactionCards question title and submit label must be non-empty')
  }
  // A pending card must be a local document: the builder appends the buttons
  // carrying the interaction identity, which a platform template cannot host.
  if (cards.approval.pendingCard !== undefined) {
    resolveCardFormat(cards.approval.pendingCard, value.cardLocale, 'feishu interactionCards approval pendingCard')
  }
  assertSettledStyle('approval', cards.approval.settledCard, cards.approval.settledTemplateId, value.cardLocale)
  assertSettledStyle('question', cards.question.settledCard, cards.question.settledTemplateId, value.cardLocale)
}

/** Validate one interaction kind's settled style: never both a local card and a platform template. */
function assertSettledStyle(kind: 'approval' | 'question', card: unknown, templateId: string | undefined, locale: string): void {
  const hasTemplate = templateId !== undefined && templateId !== ''
  if (hasTemplate && card !== undefined) {
    throw new Error(`feishu interactionCards ${kind} settled style must carry at most one of settledCard or settledTemplateId`)
  }
  if (!hasTemplate && card !== undefined) {
    resolveCardFormat(card, locale, `feishu interactionCards ${kind} settledCard`)
  }
}

/**
 * The credential references one settings section consumes. A write to any of
 * them changes what the next edge start resolves, so the plugin re-runs the
 * edge swap when the credentials seam reports one updated.
 * @param settings - the currently authoritative settings section.
 * @returns the app-id, app-secret, verification-token, and encrypt-key references.
 */
export function credentialRefsOf(settings: FeishuSettings): readonly string[] {
  return [settings.appIdEnv, settings.appSecretEnv, settings.verificationTokenEnv, settings.encryptKeyEnv]
}

/** Validate composition-only facts Schemastery cannot express. */
export function assertConfig(config: Config): void {
  assertSettings(config)
  if (config.workspacePath.trim() === '') {
    throw new Error('feishu workspacePath must be non-empty')
  }
}
