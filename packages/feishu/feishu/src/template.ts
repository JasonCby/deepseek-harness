/** Card templates: registry matching, variable resolution, and payload rendering. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { InboundMessage } from './types.ts'

/** One template slot's extraction rule. */
export interface TemplateVariableRule {
  /** Extraction source: a fixed message fact or the matched tool result's presentation meta. */
  readonly from: 'context' | 'tool-result'
  /** Context fact name: `chatId`, `senderOpenId`, or `threadId`. */
  readonly key?: string
  /** Dot path into the matched tool result's presentation meta. */
  readonly path?: string
  /** Whether an unresolvable value fails the whole template. */
  readonly required?: boolean
  /** Character ceiling; an over-long value fails the whole template. */
  readonly maxLength?: number
}

/** One registered card template and the tool turn it binds to. */
export interface CardTemplateEntry {
  /** Registry name, unique within the section. */
  readonly name: string
  /** Tool name whose call in the turn selects this template. */
  readonly bindTool: string
  /** Optional secondary filter on the workflow run's display name. */
  readonly workflowName?: string
  /** Platform template identity from the tenant's card builder. */
  readonly templateId?: string
  /**
   * Local card document carrying `{{variable}}` placeholders in string values:
   * canonical card JSON 1.0 (top-level `elements`) or the card builder's
   * multilingual export (`i18n_elements`/`i18n_header`, lifted from
   * `cardLocale` at render).
   */
  readonly card?: unknown
  /** Extraction rules keyed by template variable name. */
  readonly variables: Record<string, TemplateVariableRule>
}

/** One templated reply payload: a platform template reference or a filled local card. */
export type TemplateReplyPayload =
  | { readonly kind: 'template'; readonly templateId: string; readonly variables: Record<string, string> }
  | { readonly kind: 'localCard'; readonly card: unknown }

/** Read one fixed message fact a context-source rule may name. */
function contextFact(message: InboundMessage, key: string): string | undefined {
  if (key === 'chatId') return message.chatId
  if (key === 'senderOpenId') return message.senderOpenId
  if (key === 'threadId') return message.threadId
  return undefined
}

/** Walk one dot path over objects and arrays; a missing segment resolves undefined. */
function readPath(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const segment of path.split('.')) {
    if (segment === '') return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      current = Number.isInteger(index) ? current[index] : undefined
    } else if (current !== null && typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
    if (current === undefined || current === null) return undefined
  }
  return current
}

/** Presentation meta of the last tool result whose call named one tool, or undefined. */
function lastToolResultMeta(events: readonly SessionEvent[], fromSeq: number, tool: string): unknown {
  const callTools = new Map<string, string>()
  let meta: unknown
  for (const event of events) {
    if (event.seq < fromSeq) continue
    if (event.type === 'tool/call') {
      callTools.set(event.data.callId, event.data.name)
      continue
    }
    if (event.type !== 'tool/result') continue
    const source = event.data.message.source
    if (callTools.get(source.callId) !== tool) continue
    meta = event.data.meta
  }
  return meta
}

/**
 * Find the first registry entry whose bound tool ran in the turn's window.
 * @param entries - the configured template registry, in priority order.
 * @param events - the session's ordered event log.
 * @param fromSeq - the log position just before the triggering prompt was admitted.
 * @returns the matching entry, or undefined when no binding selects a template.
 */
export function matchCardTemplate(
  entries: readonly CardTemplateEntry[],
  events: readonly SessionEvent[],
  fromSeq: number,
): CardTemplateEntry | undefined {
  const toolNames = new Set<string>()
  const runNames = new Set<string>()
  for (const event of events) {
    if (event.seq < fromSeq) continue
    if (event.type === 'tool/call') toolNames.add(event.data.name)
    // The tool-workflow family is declaration-merged by its own package; the
    // prefix reaches members this package's type set does not name.
    if (event.type.startsWith('tool-workflow/run-start')) {
      const name = (event.data as { name?: unknown }).name
      if (typeof name === 'string') runNames.add(name)
    }
  }
  return entries.find(entry => toolNames.has(entry.bindTool)
    && (entry.workflowName === undefined || runNames.has(entry.workflowName)))
}

/** One template's resolved variables, or the failure that rules the template out. */
export type ResolvedTemplateVariables =
  | { readonly variables: Record<string, string> }
  | { readonly error: string }

/**
 * Resolve one entry's variables from the turn's logged state and message facts.
 * @param entry - the matched template.
 * @param events - the session's ordered event log.
 * @param fromSeq - the log position just before the triggering prompt was admitted.
 * @param message - the routed message the turn answers.
 * @returns the variable map, or the first failure that rules the template out.
 */
export function resolveTemplateVariables(
  entry: CardTemplateEntry,
  events: readonly SessionEvent[],
  fromSeq: number,
  message: InboundMessage,
): ResolvedTemplateVariables {
  const variables: Record<string, string> = {}
  const meta = lastToolResultMeta(events, fromSeq, entry.bindTool)
  for (const [name, rule] of Object.entries(entry.variables)) {
    const value = rule.from === 'context'
      ? contextFact(message, rule.key ?? '')
      : readPath(meta, rule.path ?? '')
    if (value === undefined) {
      if (rule.required === true) return { error: `variable "${name}" is unresolvable` }
      continue
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (rule.maxLength !== undefined && text.length > rule.maxLength) {
      return { error: `variable "${name}" exceeds ${String(rule.maxLength)} characters` }
    }
    variables[name] = text
  }
  return { variables }
}

/** Substitute `{{name}}` placeholders inside one local card's string values. */
function interpolateCard(card: unknown, variables: Record<string, string>): unknown {
  if (typeof card === 'string') {
    return card.replace(/\{\{(\w+)\}\}/g, (_whole, name: string) => variables[name] ?? '')
  }
  if (Array.isArray(card)) return card.map(item => interpolateCard(item, variables))
  if (card === null || typeof card !== 'object') return card
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(card)) out[key] = interpolateCard(value, variables)
  return out
}

/** Card JSON dialects a local template card may carry; `'v2'` is reserved for a future release. */
export type CardInputFormat = 'v1' | 'v1-builder-i18n'

/**
 * Resolve and validate which card JSON dialect one local card carries.
 * Card JSON 2.0 documents fail by name so a misconfigured tenant entry is
 * actionable at settings validation, long before a turn renders it.
 * @param card - the configured card document.
 * @param locale - the builder multilingual key the card must carry under `i18n_elements`.
 * @param label - the entry description error messages cite.
 * @returns the resolved dialect.
 * @throws on card JSON 2.0, an unrecognized shape, or a missing locale.
 */
export function resolveCardFormat(card: unknown, locale: string, label: string): CardInputFormat {
  if (card === null || typeof card !== 'object' || Array.isArray(card)) {
    throw new Error(`${label} must be a card JSON object`)
  }
  const record = card as Record<string, unknown>
  if (record['schema'] === '2.0' || record['body'] !== undefined) {
    throw new Error(`${label} is card JSON 2.0, which is not supported yet; export a 1.0 or multilingual document from the card builder, or bind a platform templateId instead`)
  }
  const i18n = record['i18n_elements']
  if (i18n !== undefined) {
    const localeElements = i18n !== null && typeof i18n === 'object' && !Array.isArray(i18n)
      ? (i18n as Record<string, unknown>)[locale]
      : undefined
    if (!Array.isArray(localeElements) || localeElements.length === 0) {
      throw new Error(`${label} must carry a non-empty "${locale}" elements array under i18n_elements`)
    }
    return 'v1-builder-i18n'
  }
  if (Array.isArray(record['elements']) && record['elements'].length > 0) {
    return 'v1'
  }
  throw new Error(`${label} must carry a non-empty top-level elements array or an i18n_elements map`)
}

/** Give every bare `img` element the `alt` object card JSON 1.0 requires. */
function ensureImgAlt(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(ensureImgAlt)
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) out[key] = ensureImgAlt(value)
  if (out['tag'] === 'img' && out['alt'] === undefined) out['alt'] = { tag: 'plain_text', content: '' }
  return out
}

/**
 * Normalize one configured local card onto the canonical card JSON 1.0 send
 * form: top-level `config`, an optional `header`, and a non-empty `elements`
 * array, with every bare `img` given the `alt` 1.0 requires.
 * @param card - the configured card document, already accepted by {@link resolveCardFormat}.
 * @param locale - the builder multilingual key lifted to `elements` and `header`.
 * @param label - the entry description error messages cite.
 * @returns the canonical card JSON 1.0 document.
 * @throws when the document no longer matches any accepted dialect.
 */
export function normalizeTemplateCard(card: unknown, locale: string, label: string): Record<string, unknown> {
  const format = resolveCardFormat(card, locale, label)
  switch (format) {
    case 'v1':
      return ensureImgAlt(card) as Record<string, unknown>
    case 'v1-builder-i18n': {
      const source = card as Record<string, unknown>
      const lifted: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(source)) {
        if (key === 'i18n_elements' || key === 'i18n_header') continue
        lifted[key] = value
      }
      lifted['elements'] = (source['i18n_elements'] as Record<string, unknown>)[locale]
      const header = (source['i18n_header'] as Record<string, unknown> | undefined)?.[locale]
      if (header !== undefined) lifted['header'] = header
      return ensureImgAlt(lifted) as Record<string, unknown>
    }
    default:
      return assertNever(format)
  }
}

/**
 * Render one entry's reply payload from resolved variables.
 * @param entry - the matched template carrying exactly one template form.
 * @param variables - resolved variable values.
 * @param locale - the builder multilingual key lifted when the local card is a builder export.
 * @returns the platform template payload or the interpolated canonical card JSON 1.0.
 */
export function renderTemplateReply(entry: CardTemplateEntry, variables: Record<string, string>, locale: string = 'zh_cn'): TemplateReplyPayload {
  if (entry.templateId !== undefined) {
    return { kind: 'template', templateId: entry.templateId, variables }
  }
  const label = `feishu cardTemplates entry "${entry.name}" card`
  return { kind: 'localCard', card: interpolateCard(normalizeTemplateCard(entry.card, locale, label), variables) }
}

/**
 * Keys card JSON 2.0 added that no card JSON 1.0 element accepts; dropped on
 * projection. `margin` and `horizontal_spacing` stay: 1.0 `column_set` and
 * `column` carry them natively.
 */
const V2_ONLY_KEYS = new Set(['element_id', 'padding', 'corner_radius', 'fallback_img_key'])

/** Recursively drop card JSON 2.0-only keys from one document. */
function dropV2Keys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(dropV2Keys)
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (V2_ONLY_KEYS.has(key)) continue
    out[key] = dropV2Keys(value)
  }
  return out
}

/**
 * Project one card JSON 2.0 document onto the 1.0 structure: `body.elements`
 * lifts to the top level, 2.0-only keys drop, and bare `img` elements gain
 * the `alt` 1.0 requires. Reserved for the future `'v2'` input dialect: the
 * accepted pipeline rejects 2.0 at {@link resolveCardFormat}, so nothing
 * routes here until that dialect joins {@link CardInputFormat}.
 * @param card - the 2.0 document.
 * @returns the 1.0 document with `schema` and `body` dropped.
 */
export function convertCardV2toV1(card: unknown): unknown {
  const converted = ensureImgAlt(dropV2Keys(card))
  if (converted === null || typeof converted !== 'object' || Array.isArray(converted)) return converted
  const record = { ...(converted as Record<string, unknown>) }
  const body = record['body']
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const elements = (body as Record<string, unknown>)['elements']
    if (elements !== undefined) record['elements'] = elements
    delete record['body']
  }
  delete record['schema']
  return record
}
