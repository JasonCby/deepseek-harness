/**
 * Interactive-card bridge: answers in-turn approval and user-question
 * waterfalls with Feishu cards, matches card-action callbacks back to the
 * pending interaction they resolve, and updates the card in the callback
 * response. Callbacks must settle within Feishu's three-second response
 * window, so resolution only unblocks the waterfall; the agent's continued
 * turn runs asynchronously.
 * @module @deepseek-ai/dsh-feishu/interaction
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import type { FeishuSettings } from './config.ts'
import { buildApprovalCard, buildQuestionCard, buildSettledCard, QUESTION_FIELD_PREFIX } from './interaction-card.ts'
import type { ReplySender } from './reply.ts'
import type { InteractionId } from './types.ts'

/** One card-action callback response: an optional toast plus the card update replacing the pending card. */
export interface CardActionResponse {
  readonly toast?: { readonly type: 'success' | 'info' | 'error'; readonly content: string }
  readonly card?:
    | { readonly type: 'raw'; readonly data: unknown }
    | { readonly type: 'template'; readonly data: { readonly template_id: string; readonly template_variable: Record<string, string> } }
}

/** One inbound card-action callback after wire validation. */
export interface CardAction {
  /** Interaction identity the clicked component's value carried. */
  readonly interactionId: string | undefined
  /** Approval verdict a button value carried, when the click was an approval button. */
  readonly outcome: 'approved' | 'rejected' | undefined
  /** Submitted form field values keyed by component name, when the click submitted a form. */
  readonly formValue: Readonly<Record<string, unknown>> | undefined
  /** Acting operator's open id. */
  readonly operatorOpenId: string | undefined
}

/**
 * Validate one card-action callback body down to the fields the bridge uses.
 * The SDK handler delivers the flattened v2 form: `header` and `event`
 * merged, so `action` and `operator` sit at the top level.
 * @param body - the parsed callback body as the SDK handler delivers it.
 * @returns the admitted action, or undefined when the body is not one.
 */
export function parseCardAction(body: unknown): CardAction | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const operator = (body as { operator?: unknown }).operator
  const action = (body as { action?: unknown }).action
  if (action === null || typeof action !== 'object') return undefined
  const value = (action as { value?: unknown }).value
  const formValue = (action as { form_value?: unknown }).form_value
  const interactionId = value !== null && typeof value === 'object'
    ? (value as { interactionId?: unknown }).interactionId
    : undefined
  const outcome = value !== null && typeof value === 'object'
    ? (value as { outcome?: unknown }).outcome
    : undefined
  if (interactionId !== undefined && (typeof interactionId !== 'string' || interactionId === '')) return undefined
  if (formValue !== undefined && (formValue === null || typeof formValue !== 'object' || Array.isArray(formValue))) return undefined
  const operatorOpenId = operator !== null && typeof operator === 'object'
    ? (operator as { open_id?: unknown }).open_id
    : undefined
  return {
    interactionId,
    outcome: outcome === 'approved' || outcome === 'rejected' ? outcome : undefined,
    formValue: formValue === undefined ? undefined : { ...(formValue as Record<string, unknown>) },
    operatorOpenId: operatorOpenId === undefined || typeof operatorOpenId !== 'string' ? undefined : operatorOpenId,
  }
}

/** One pending interaction awaiting its card-action callback. */
interface Pending {
  readonly kind: 'approval' | 'question'
  readonly questions: readonly AskUserQuestionItem[]
  /** Resolves the claimed waterfall; returning afterwards is a settled no-op. */
  readonly settle: (result: ApprovalOutcome | AskUserQuestionAnswer) => void
}

/**
 * The plugin-scoped interaction bridge. One instance serves every chat
 * agent: per-agent waterfall answerers register on each agent's scoped
 * context, while the pending table and the callback dispatch are shared so
 * the HTTP card route finds any live conversation's interaction.
 */
export class InteractionBridge {
  private readonly pendings = new Map<string, Pending>()
  private readonly anchors = new Map<SessionId, string>()
  private reply: ReplySender

  /**
   * @param ctx - plugin context for lifecycle logging.
   * @param settings - thunk returning the currently authoritative settings section.
   * @param placeholderReply - sender used before the first transport edge activates.
   */
  constructor(
    private readonly ctx: Context,
    private readonly settings: () => FeishuSettings,
    placeholderReply: ReplySender,
  ) {
    this.reply = placeholderReply
  }

  /**
   * Point interaction cards at the active transport edge's sender. The
   * controller calls this beside the router's own sender updates.
   * @param sender - the active edge's reply sender.
   */
  setReplySender(sender: ReplySender): void {
    this.reply = sender
  }

  /**
   * Record the message one session's live turn replies to, so an interaction
   * requested mid-turn can reply its card to the same anchor message. The
   * router sets this before admitting the turn's prompt and clears it after.
   * @param sessionId - the session about to run a turn.
   * @param messageId - the inbound message the turn answers.
   */
  setAnchor(sessionId: SessionId, messageId: string): void {
    this.anchors.set(sessionId, messageId)
  }

  /** Forget one session's anchor; its turn settled. */
  clearAnchor(sessionId: SessionId): void {
    this.anchors.delete(sessionId)
  }

  /**
   * Register this bridge's waterfall answerers on one agent's scoped context,
   * ahead of the host-level forwarders that registered at boot. The remote
   * event forwarder claims every request it sees and only delegates when its
   * client gives up, so a later-registered channel answerer would never run;
   * prepending puts the anchored claim first while unanchored turns still
   * pass through `next()`. Cordis removes the listeners with the scope, so an
   * agent's teardown also drops its claim path; a pending interaction
   * outliving its agent settles as cancelled through the request signal.
   * @param scope - the agent's scoped context (a setup callback's `agentCtx`, or a live agent's own ctx).
   * @param agent - the agent whose approval and question requests the cards answer.
   */
  mountAnswerers(scope: Context, agent: Agent): void {
    scope.on('approval/request', (req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) =>
      this.answerApproval(agent, req, next), true)
    scope.on('user-questions/request', (req: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>) =>
      this.answerQuestion(agent, req, next), true)
  }

  /**
   * Settle one pending interaction as cancelled when its request aborts. The
   * card cannot be refreshed without a callback, so a later click meets the
   * stale reply.
   * @param interaction - the pending interaction's identity.
   * @param kind - the interaction kind the pending entry must still carry.
   * @param signal - the request's cancellation lifetime, when present.
   * @param settle - the cancellation resolution for the claimed waterfall.
   */
  private settleOnAbort(interaction: InteractionId, kind: Pending['kind'], signal: AbortSignal | undefined, settle: () => void): void {
    signal?.addEventListener('abort', () => {
      if (this.pendings.get(interaction)?.kind === kind) {
        this.pendings.delete(interaction)
        settle()
      }
    }, { once: true })
  }

  /** Answer one approval request with a confirm card, or delegate when the turn is not this channel's. */
  private async answerApproval(agent: Agent, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const cards = this.settings().interactionCards
    if (!cards.enabled) return next()
    const anchor = this.anchors.get(agent.session.id)
    if (anchor === undefined) return next()
    const interaction = brandString<InteractionId>(`fi-${randomUUID()}`)
    const card = buildApprovalCard(interaction, req.toolName, req.reason, {
      ...cards.approval.pendingCard === undefined ? {} : { card: cards.approval.pendingCard },
      approveLabel: cards.approval.approveLabel,
      rejectLabel: cards.approval.rejectLabel,
    })
    try {
      await this.reply(anchor, { kind: 'localCard', card })
    } catch (error: unknown) {
      // No card delivered means no callback can arrive; the request passes on
      // so another channel (or the service's fail-closed default) answers.
      this.ctx.logger.warn(`feishu: approval card for ${agent.session.id} was not delivered: ${error instanceof Error ? error.message : String(error)}`)
      return next()
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      this.pendings.set(interaction, {
        kind: 'approval',
        questions: [],
        settle: (result) => {
          resolve(result as ApprovalOutcome)
        },
      })
      this.settleOnAbort(interaction, 'approval', req.signal, () => {
        resolve('cancelled')
      })
    })
  }

  /** Answer one user-question request with a form card, or delegate when the turn is not this channel's. */
  private async answerQuestion(
    agent: Agent,
    req: AskUserQuestionRequestEvent,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const cards = this.settings().interactionCards
    if (!cards.enabled) return next()
    const anchor = this.anchors.get(agent.session.id)
    if (anchor === undefined) return next()
    const interaction = brandString<InteractionId>(`fi-${randomUUID()}`)
    const card = buildQuestionCard(interaction, req.questions, {
      title: cards.question.title,
      submitLabel: cards.question.submitLabel,
    })
    try {
      await this.reply(anchor, { kind: 'localCard', card })
    } catch (error: unknown) {
      this.ctx.logger.warn(`feishu: question card for ${agent.session.id} was not delivered: ${error instanceof Error ? error.message : String(error)}`)
      return next()
    }
    return new Promise<AskUserQuestionAnswer>((resolve) => {
      this.pendings.set(interaction, {
        kind: 'question',
        questions: req.questions,
        settle: (result) => {
          resolve(result as AskUserQuestionAnswer)
        },
      })
      this.settleOnAbort(interaction, 'question', req.signal, () => {
        resolve(answersOf([], {}))
      })
    })
  }

  /**
   * Resolve one admitted card-action callback: settle the pending
   * interaction it matches and produce the response that refreshes the card.
   * @param action - the validated callback action.
   * @returns the callback response body; malformed or unknown interactions
   * still answer successfully so Feishu does not retry a stale click.
   */
  dispatch(action: CardAction): CardActionResponse {
    if (action.interactionId === undefined) return this.staleResponse()
    const pending = this.pendings.get(action.interactionId)
    if (pending === undefined) return this.staleResponse()
    this.pendings.delete(action.interactionId)
    if (pending.kind === 'approval') {
      if (action.outcome === undefined) return this.staleResponse()
      const outcome: ApprovalOutcome = action.outcome === 'approved' ? 'allowed-once' : 'rejected'
      pending.settle(outcome)
      return this.settledResponse(outcome, action.operatorOpenId, undefined, 'approval')
    }
    const answers = answersOf(pending.questions, action.formValue ?? {})
    pending.settle(answers)
    return this.settledResponse('answered', action.operatorOpenId, summarize(answers, pending.questions), 'question')
  }

  /** Response for a click nothing pending can match: a toast, leaving the card unchanged. */
  private staleResponse(): CardActionResponse {
    return { toast: { type: 'info', content: 'This interaction has already been settled.' } }
  }

  /** Build the settled card response under the configured style. */
  private settledResponse(
    outcome: string,
    decidedBy: string | undefined,
    summary: string | undefined,
    kind: 'approval' | 'question',
  ): CardActionResponse {
    const cards = this.settings().interactionCards
    const templateId = kind === 'approval' ? cards.approval.settledTemplateId : cards.question.settledTemplateId
    if (templateId !== undefined) {
      return {
        card: {
          type: 'template',
          data: {
            template_id: templateId,
            template_variable: {
              outcome,
              ...decidedBy === undefined ? {} : { decidedBy },
              ...summary === undefined ? {} : { summary },
            },
          },
        },
      }
    }
    const frame = kind === 'approval' ? cards.approval.settledCard : cards.question.settledCard
    return { card: { type: 'raw', data: buildSettledCard(outcome, decidedBy, summary, frame) } }
  }
}

/**
 * Map one submitted form's field values onto the answer items of the
 * questions the form was built from. Select fields carry selected labels;
 * text inputs on option-less questions carry the custom answer.
 * @param questions - the questions the pending form card was built from.
 * @param formValue - the submitted field values keyed by component name.
 * @returns the structured answer the waterfall resolves with.
 */
function answersOf(questions: readonly AskUserQuestionItem[], formValue: Readonly<Record<string, unknown>>): AskUserQuestionAnswer {
  const answers: AskUserQuestionAnswerItem[] = []
  for (const item of questions) {
    const value = formValue[`${QUESTION_FIELD_PREFIX}${item.id}`]
    let selected: string[] = []
    let custom: string | undefined
    if (Array.isArray(value)) {
      selected = value.map(entry => String(entry))
    } else if (typeof value === 'string' && value !== '') {
      if (item.options !== undefined && item.options.length > 0) {
        selected = [value]
      } else {
        custom = value
      }
    }
    answers.push({ id: item.id, selected, ...custom === undefined ? {} : { custom } })
  }
  return { answers }
}

/**
 * Render one settled form's answers as the summary line of its settled card.
 * @param answers - the structured answers the form resolved to.
 * @param questions - the questions the form card asked.
 * @returns the summary text, or undefined when nothing carried an answer.
 */
function summarize(answers: AskUserQuestionAnswer, questions: readonly AskUserQuestionItem[]): string | undefined {
  const byId = new Map(questions.map(question => [question.id, question]))
  const lines: string[] = []
  for (const answer of answers.answers) {
    const chosen = [...answer.selected, ...answer.custom === undefined ? [] : [answer.custom]]
    if (chosen.length === 0) continue
    lines.push(`${byId.get(answer.id)?.question ?? answer.id}: ${chosen.join(', ')}`)
  }
  return lines.length === 0 ? undefined : lines.join('\n')
}
