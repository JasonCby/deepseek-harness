/**
 * Interactive-card builders: approval confirmations and ask-user forms as
 * card JSON 1.0. A configured style overrides only the presentation frame;
 * the interactive components (buttons, form inputs) are always generated
 * here because they carry the interaction identity the callback matches.
 * @module @deepseek-ai/dsh-feishu/interaction-card
 */

import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { interpolateCard } from './template.ts'
import type { InteractionId } from './types.ts'

/** Presentation knobs of one approval confirm card. */
export interface ApprovalCardStyle {
  /** Local card JSON 1.0 frame with `{{toolName}}`/`{{reason}}` placeholders; the button row is appended. */
  readonly card?: unknown
  /** Approve button label. */
  readonly approveLabel: string
  /** Reject button label. */
  readonly rejectLabel: string
}

/** Presentation knobs of one ask-user form card. */
export interface QuestionCardStyle {
  /** Card header title; the form body is generated from the questions. */
  readonly title: string
  /** Form submit button label. */
  readonly submitLabel: string
}

/** Component name prefix that marks one form field as the answer of question `id`. */
export const QUESTION_FIELD_PREFIX = 'q_'

function plain(text: string): { tag: 'plain_text'; content: string } {
  return { tag: 'plain_text', content: text }
}

function markdown(content: string): { tag: 'markdown'; content: string } {
  return { tag: 'markdown', content }
}

/** Default approval frame the blue-banner projection builds. */
function defaultApprovalCard(variables: Record<string, string>): Record<string, unknown> {
  return {
    header: { template: 'blue', title: plain('Approval required') },
    elements: [markdown(`**${variables.toolName ?? ''}**\nApproval is required to continue.`)],
  }
}

/** Elements of one base frame: the configured card's elements, or one empty markdown spacer. */
function frameElements(frame: unknown): { tag: string; [key: string]: unknown }[] {
  if (frame !== null && typeof frame === 'object' && Array.isArray((frame as { elements?: unknown }).elements)) {
    return [...(frame as { elements: { tag: string; [key: string]: unknown }[] }).elements]
  }
  return [markdown(' ')]
}

/** Frame of one frame override after placeholder interpolation, with its header kept. */
function baseCard(frame: unknown, variables: Record<string, string>): Record<string, unknown> {
  const interpolated = interpolateCard(frame, variables)
  if (interpolated !== null && typeof interpolated === 'object' && !Array.isArray(interpolated)) {
    return { ...(interpolated as Record<string, unknown>) }
  }
  return {}
}

/**
 * Build one approval confirm card: the configured frame (or the default
 * blue-banner projection) plus one row of approve/reject buttons carrying the
 * interaction identity in their callback values.
 * @param interaction - identity the button values carry back on click.
 * @param toolName - tool whose execution awaits the decision.
 * @param reason - caller-stated justification, when present.
 * @param style - the live approval card style.
 * @returns the card JSON 1.0 document to send as an `interactive` reply.
 */
export function buildApprovalCard(
  interaction: InteractionId,
  toolName: string,
  reason: string | undefined,
  style: ApprovalCardStyle,
): Record<string, unknown> {
  const variables = {
    toolName,
    ...reason === undefined ? {} : { reason },
  }
  const card = style.card === undefined
    ? defaultApprovalCard(variables)
    : baseCard(style.card, variables)
  const elements = frameElements(card)
  elements.push({
    tag: 'action',
    actions: [
      { tag: 'button', text: plain(style.approveLabel), type: 'primary', value: { interactionId: interaction, outcome: 'approved' } },
      { tag: 'button', text: plain(style.rejectLabel), type: 'danger', value: { interactionId: interaction, outcome: 'rejected' } },
    ],
  })
  return { ...card, elements }
}

/**
 * Build one ask-user form card: one markdown label and one field per
 * question — options project to a select (multi-select when the question
 * allows several), everything else to a text input — inside a form whose
 * submit button carries the interaction identity.
 * @param interaction - identity the submit button value carries back.
 * @param questions - the questions the agent asked.
 * @param style - the live question card style.
 * @returns the card JSON 1.0 document to send as an `interactive` reply.
 */
export function buildQuestionCard(
  interaction: InteractionId,
  questions: readonly AskUserQuestionItem[],
  style: QuestionCardStyle,
): Record<string, unknown> {
  const fields: { tag: string; name?: string; [key: string]: unknown }[] = []
  for (const item of questions) {
    const label = `**${item.question}**${item.detail === undefined ? '' : `\n${item.detail}`}`
    fields.push(markdown(label))
    const name = `${QUESTION_FIELD_PREFIX}${item.id}`
    if (item.options !== undefined && item.options.length > 0) {
      const options = item.options.map(option => ({ text: plain(option.label) }))
      fields.push(item.multiSelect === true
        ? { tag: 'multi_select_static', name, options }
        : { tag: 'select_static', name, placeholder: plain(item.header ?? item.question), options },
      )
      continue
    }
    fields.push({ tag: 'input', name, placeholder: plain(item.question) })
  }
  fields.push({
    tag: 'button',
    action_type: 'form_submit',
    name: 'dsh_submit',
    type: 'primary',
    text: plain(style.submitLabel),
    value: { interactionId: interaction },
  })
  return {
    header: { template: 'blue', title: plain(style.title) },
    elements: [{ tag: 'form', name: 'dsh_form', elements: fields }],
  }
}

/** Human-readable label of one settlement outcome. */
const OUTCOME_LABELS: Record<string, string> = {
  'allowed-once': 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  expired: 'Expired',
}

/**
 * Build one settled card replacing a pending interaction card.
 * @param outcomeLabel - the human-readable outcome already resolved for the interaction.
 * @param decidedBy - the deciding operator's open id, when a callback carried it.
 * @param summary - the answers summary of a settled form, when present.
 * @param frame - the configured settled-style frame with `{{outcome}}`/`{{decidedBy}}`/`{{summary}}` placeholders.
 * @returns the card JSON 1.0 document the callback response updates the card with.
 */
export function buildSettledCard(
  outcome: string,
  decidedBy: string | undefined,
  summary: string | undefined,
  frame: unknown,
): Record<string, unknown> {
  const variables = {
    outcome: OUTCOME_LABELS[outcome] ?? outcome,
    ...decidedBy === undefined ? {} : { decidedBy },
    ...summary === undefined ? {} : { summary },
  }
  if (frame !== undefined) return baseCard(frame, variables)
  const lines = [`**${variables.outcome}**`]
  if (decidedBy !== undefined) lines.push(decidedBy)
  if (summary !== undefined) lines.push(summary)
  return {
    header: { template: 'grey', title: plain('Interaction settled') },
    elements: [markdown(lines.join('\n'))],
  }
}
