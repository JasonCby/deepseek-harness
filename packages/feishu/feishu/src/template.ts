/** Card templates: registry matching, variable resolution, and payload rendering. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
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
  /** Local card JSON 1.0 skeleton carrying `{{variable}}` placeholders in string values. */
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

/**
 * Render one entry's reply payload from resolved variables.
 * @param entry - the matched template carrying exactly one template form.
 * @param variables - resolved variable values.
 * @returns the platform template payload or the interpolated local card.
 */
export function renderTemplateReply(entry: CardTemplateEntry, variables: Record<string, string>): TemplateReplyPayload {
  if (entry.templateId !== undefined) {
    return { kind: 'template', templateId: entry.templateId, variables }
  }
  return { kind: 'localCard', card: interpolateCard(entry.card, variables) }
}

/** Keys card JSON 2.0 added that 1.0 deployments reject or ignore; dropped on conversion. */
const V2_ONLY_KEYS = new Set(['element_id', 'margin', 'padding', 'corner_radius', 'fallback_img_key', 'horizontal_spacing'])

/** Recursively drop 2.0-only keys and give bare img elements the 1.0 alt. */
function convertNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convertNode)
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (V2_ONLY_KEYS.has(key)) continue
    out[key] = convertNode(value)
  }
  if (out['tag'] === 'img' && out['alt'] === undefined) {
    out['alt'] = { tag: 'plain_text', content: '' }
  }
  return out
}

/**
 * Project one builder-exported card JSON 2.0 document onto the 1.0 structure.
 * @param card - the 2.0 document; `body.elements` lifts to the top level.
 * @returns the 1.0 document with `schema` and `body` dropped.
 */
export function convertCardV2toV1(card: unknown): unknown {
  const converted = convertNode(card)
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
