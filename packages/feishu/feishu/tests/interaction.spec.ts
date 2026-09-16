/** Interactive-card tests: builders, callback parsing, settings validation, and the bridge's waterfall answers. */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@deepseek-ai/dsh-user-questions/types'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertSettings, type FeishuSettings } from '../src/config.ts'
import { buildApprovalCard, buildQuestionCard, buildSettledCard, QUESTION_FIELD_PREFIX } from '../src/interaction-card.ts'
import { InteractionBridge, parseCardAction, type CardActionResponse } from '../src/interaction.ts'
import { sessionIdForChat } from '../src/conversation.ts'
import type { ReplyContent, ReplySender } from '../src/reply.ts'

/** One mutable settings section the bridge reads live. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

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
    replyCharLimit: 4000,
    replyForm: 'text',
    cardTitle: 'DSH',
    cardLocale: 'zh_cn',
    thinkingEmoji: 'Typing',
    failureNotice: 'failed',
    dedupCapacity: 64,
    cardTemplates: [],
    interactionCards: {
      enabled: true,
      approval: { approveLabel: 'Approve', rejectLabel: 'Reject' },
      question: { title: 'Please answer', submitLabel: 'Submit' },
    },
  }
}

/** One approval card the bridge sent, as the fake reply sender recorded it. */
interface SentCard {
  readonly messageId: string
  readonly card: Record<string, unknown>
}

/** Interaction identity carried by the first button value of one sent approval card. */
function interactionOfButtons(card: Record<string, unknown>): string {
  const elements = card['elements'] as { tag: string; actions?: { value?: { interactionId?: string } }[] }[]
  for (const element of elements) {
    if (element.tag !== 'action') continue
    for (const action of element.actions ?? []) {
      const id = action.value?.interactionId
      if (typeof id === 'string') return id
    }
  }
  throw new Error('no interaction button on the sent card')
}

/** Interaction identity the form card's submit button value carries. */
function interactionOfForm(card: Record<string, unknown>): string {
  const elements = card['elements'] as { tag: string; elements?: { value?: { interactionId?: string } }[] }[]
  for (const element of elements) {
    if (element.tag !== 'form') continue
    for (const field of element.elements ?? []) {
      const id = field.value?.interactionId
      if (typeof id === 'string') return id
    }
  }
  throw new Error('no submit button on the sent form card')
}

/** One bridge under test plus the cards its reply sender captured. */
function makeBridge(live: FeishuSettings): { bridge: InteractionBridge; ctx: Context; sent: SentCard[] } {
  const ctx = new Context()
  const sent: SentCard[] = []
  const sender: ReplySender = async (messageId, content: ReplyContent) => {
    if (content.kind !== 'localCard') throw new Error(`unexpected reply kind ${content.kind}`)
    sent.push({ messageId, card: content.card as Record<string, unknown> })
  }
  return { bridge: new InteractionBridge(ctx, () => live, sender), ctx, sent }
}

/** One agent stub whose session the answerers anchor cards to. */
function agent(): Agent {
  return { session: { id: sessionIdForChat('oc_1') } } as unknown as Agent
}

/** One approval request event as the waterfall delivers it. */
function approvalRequest(owner: Agent, signal?: AbortSignal): ApprovalRequestEvent {
  return { agent: owner, toolName: 'bash', reason: 'remove build output', ...signal === undefined ? {} : { signal } }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('interaction cards', () => {
  it('builds an approval card whose buttons carry the interaction identity', () => {
    const card = buildApprovalCard('fi-1' as never, 'bash', 'why', { approveLabel: '允许', rejectLabel: '拒绝' })
    const elements = card['elements'] as { tag: string; actions?: { text: { content: string }; value: { interactionId: string; outcome: string } }[] }[]
    const actions = elements.at(-1)?.actions ?? []
    expect(actions.map(action => [action.text.content, action.value])).toEqual([
      ['允许', { interactionId: 'fi-1', outcome: 'approved' }],
      ['拒绝', { interactionId: 'fi-1', outcome: 'rejected' }],
    ])
  })

  it('interpolates a configured approval frame and still appends the buttons', () => {
    const card = buildApprovalCard('fi-1' as never, 'bash', undefined, {
      card: { header: { template: 'turquoise', title: { tag: 'plain_text', content: '{{toolName}} review' } }, elements: [{ tag: 'markdown', content: 'Approve {{toolName}}?' }] },
      approveLabel: 'Approve',
      rejectLabel: 'Reject',
    })
    expect(card['header']).toEqual({ template: 'turquoise', title: { tag: 'plain_text', content: 'bash review' } })
    const elements = card['elements'] as { tag: string }[]
    expect(elements.map(element => element.tag)).toEqual(['markdown', 'action'])
  })

  it('projects questions onto form fields by option shape', () => {
    const card = buildQuestionCard('fi-2' as never, [
      { id: 'q1', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'q2', question: 'Pick many', options: [{ label: 'X' }, { label: 'Y' }], multiSelect: true },
      { id: 'q3', question: 'Say something' },
    ], { title: 'T', submitLabel: 'Go' })
    const form = (card['elements'] as { tag: string; elements?: { tag: string; name?: string }[] }[])[0]
    expect(form?.['tag']).toBe('form')
    const fields = form?.elements ?? []
    expect(fields.map(field => [field.tag, field.name ?? ''])).toEqual([
      ['markdown', ''],
      ['select_static', `${QUESTION_FIELD_PREFIX}q1`],
      ['markdown', ''],
      ['multi_select_static', `${QUESTION_FIELD_PREFIX}q2`],
      ['markdown', ''],
      ['input', `${QUESTION_FIELD_PREFIX}q3`],
      ['button', 'dsh_submit'],
    ])
  })

  it('renders settled cards from defaults and configured frames', () => {
    const built = buildSettledCard('allowed-once', 'ou_9', 'q1: A', undefined) as { header: { template: string }; elements: { content: string }[] }
    expect(built.header.template).toBe('grey')
    expect(built.elements[0]!.content).toContain('Approved')
    const framed = buildSettledCard('rejected', undefined, undefined, { elements: [{ tag: 'markdown', content: 'Outcome: {{outcome}}' }] }) as { elements: { content: string }[] }
    expect(framed.elements[0]!.content).toBe('Outcome: Rejected')
  })

  it('admits well-formed card actions and rejects the rest', () => {
    const button = parseCardAction({
      operator: { open_id: 'ou_1' },
      action: { tag: 'button', value: { interactionId: 'fi-1', outcome: 'approved' } },
    })
    expect(button).toEqual({ interactionId: 'fi-1', outcome: 'approved', formValue: undefined, operatorOpenId: 'ou_1' })
    const form = parseCardAction({
      operator: { open_id: 'ou_1' },
      action: { tag: 'button', value: { interactionId: 'fi-2' }, form_value: { [`${QUESTION_FIELD_PREFIX}q1`]: 'A' } },
    })
    expect(form?.formValue).toEqual({ [`${QUESTION_FIELD_PREFIX}q1`]: 'A' })
    expect(parseCardAction(null)).toBeUndefined()
    expect(parseCardAction({ action: { value: { interactionId: 3 } } })).toBeUndefined()
    expect(parseCardAction({ action: { value: { interactionId: 'fi-1' }, form_value: [] } })).toBeUndefined()
  })

  it('validates interaction card settings: labels, settled style exclusivity, and pending card dialect', () => {
    const base = settings()
    expect(() => { assertSettings(base) }).not.toThrow()
    expect(() => {
      assertSettings(structuredClone({ ...base, interactionCards: { ...base.interactionCards, approval: { ...base.interactionCards.approval, approveLabel: ' ' } } }))
    }).toThrow(/labels/)
    expect(() => {
      assertSettings(structuredClone({ ...base, interactionCards: { ...base.interactionCards, question: { ...base.interactionCards.question, settledCard: { elements: [] }, settledTemplateId: 'AAq1' } } }))
    }).toThrow(/at most one/)
    expect(() => {
      assertSettings(structuredClone({ ...base, interactionCards: { ...base.interactionCards, approval: { ...base.interactionCards.approval, pendingCard: { schema: '2.0', body: {} } } } }))
    }).toThrow(/pendingCard/)
  })
})

describe('InteractionBridge', () => {
  it('claims an anchored approval with a card and resolves the clicked verdict', async () => {
    const { bridge, ctx, sent } = makeBridge(settings())
    const owner = agent()
    bridge.mountAnswerers(ctx, owner)
    bridge.setAnchor(owner.session.id, 'om_1')
    const pending = ctx.waterfall('approval/request', approvalRequest(owner), () => Promise.resolve('unavailable' as ApprovalOutcome))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    expect(sent[0]!.messageId).toBe('om_1')
    const response = bridge.dispatch({ interactionId: interactionOfButtons(sent[0]!.card), outcome: 'approved', formValue: undefined, operatorOpenId: 'ou_1' })
    await expect(pending).resolves.toBe('allowed-once')
    expect((response.card as { data: { elements: { content: string }[] } }).data.elements[0]!.content).toContain('Approved')
    expect((response.card as { data: { elements: { content: string }[] } }).data.elements[0]!.content).toContain('ou_1')
  })

  it('resolves a rejection click as rejected', async () => {
    const { bridge, ctx, sent } = makeBridge(settings())
    const owner = agent()
    bridge.mountAnswerers(ctx, owner)
    bridge.setAnchor(owner.session.id, 'om_1')
    const pending = ctx.waterfall('approval/request', approvalRequest(owner), () => Promise.resolve('unavailable' as ApprovalOutcome))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    bridge.dispatch({ interactionId: interactionOfButtons(sent[0]!.card), outcome: 'rejected', formValue: undefined, operatorOpenId: 'ou_2' })
    await expect(pending).resolves.toBe('rejected')
  })

  it('passes unanchored, disabled, and undeliverable requests to the next answerer', async () => {
    const owner = agent()
    const delegate = () => Promise.resolve('unavailable' as ApprovalOutcome)

    const anchored = makeBridge(settings())
    anchored.bridge.mountAnswerers(anchored.ctx, owner)
    await expect(anchored.ctx.waterfall('approval/request', approvalRequest(owner), delegate)).resolves.toBe('unavailable')

    const disabled = makeBridge({ ...settings(), interactionCards: { ...settings().interactionCards, enabled: false } })
    disabled.bridge.mountAnswerers(disabled.ctx, owner)
    disabled.bridge.setAnchor(owner.session.id, 'om_1')
    await expect(disabled.ctx.waterfall('approval/request', approvalRequest(owner), delegate)).resolves.toBe('unavailable')

    const failingCtx = new Context()
    const failing = new InteractionBridge(failingCtx, () => settings(), () => Promise.reject(new Error('edge down')))
    failing.mountAnswerers(failingCtx, owner)
    failing.setAnchor(owner.session.id, 'om_1')
    await expect(failingCtx.waterfall('approval/request', approvalRequest(owner), delegate)).resolves.toBe('unavailable')
  })

  it('answers a question form with structured answers and a summary card', async () => {
    const { bridge, ctx, sent } = makeBridge(settings())
    const owner = agent()
    bridge.mountAnswerers(ctx, owner)
    bridge.setAnchor(owner.session.id, 'om_1')
    const request: AskUserQuestionRequestEvent = {
      questions: [
        { id: 'q1', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'q2', question: 'Pick many', options: [{ label: 'X' }, { label: 'Y' }], multiSelect: true },
        { id: 'q3', question: 'Say something' },
      ],
    }
    const pending = ctx.waterfall('user-questions/request', request, () => Promise.resolve({ answers: [] }))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const response = bridge.dispatch({
      interactionId: interactionOfForm(sent[0]!.card),
      outcome: undefined,
      formValue: { [`${QUESTION_FIELD_PREFIX}q1`]: 'A', [`${QUESTION_FIELD_PREFIX}q2`]: ['X', 'Y'], [`${QUESTION_FIELD_PREFIX}q3`]: 'hello' },
      operatorOpenId: 'ou_1',
    })
    const answer: AskUserQuestionAnswer = await pending
    expect(answer.answers).toEqual([
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: ['X', 'Y'] },
      { id: 'q3', selected: [], custom: 'hello' },
    ])
    const summary = ((response.card as { data: { elements: { content: string }[] } }).data.elements[0]!.content)
    expect(summary).toContain('Pick one: A')
    expect(summary).toContain('Pick many: X, Y')
    expect(summary).toContain('Say something: hello')
  })

  it('answers stale and malformed clicks without failing the callback', () => {
    const { bridge } = makeBridge(settings())
    const stale: CardActionResponse = bridge.dispatch({ interactionId: 'fi-gone', outcome: 'approved', formValue: undefined, operatorOpenId: 'ou_1' })
    expect(stale.toast?.type).toBe('info')
    expect(stale.card).toBeUndefined()
    const malformed: CardActionResponse = bridge.dispatch({
      interactionId: undefined,
      outcome: undefined,
      formValue: undefined,
      operatorOpenId: undefined,
    })
    expect(malformed.card).toBeUndefined()
  })

  it('claims ahead of a boot-time forwarder that never delegates', async () => {
    const { bridge, ctx, sent } = makeBridge(settings())
    const owner = agent()
    // A listener registered BEFORE the agent answerers, mirroring the host-level
    // remote forwarder: it claims by pending forever and never calls next().
    const stole: ApprovalRequestEvent[] = []
    ctx.on('approval/request', (req: ApprovalRequestEvent) => {
      stole.push(req)
      return new Promise<ApprovalOutcome>(() => {})
    })
    bridge.mountAnswerers(ctx, owner)
    bridge.setAnchor(owner.session.id, 'om_1')
    const pending = ctx.waterfall('approval/request', approvalRequest(owner), () => Promise.resolve('unavailable' as ApprovalOutcome))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    expect(stole).toHaveLength(0)
    bridge.dispatch({ interactionId: interactionOfButtons(sent[0]!.card), outcome: 'approved', formValue: undefined, operatorOpenId: 'ou_1' })
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('settles cancelled on an aborted request and treats later clicks as stale', async () => {
    const { bridge, ctx, sent } = makeBridge(settings())
    const owner = agent()
    bridge.mountAnswerers(ctx, owner)
    bridge.setAnchor(owner.session.id, 'om_1')
    const controller = new AbortController()
    const pending = ctx.waterfall('approval/request', approvalRequest(owner, controller.signal), () => Promise.resolve('unavailable' as ApprovalOutcome))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const interactionId = interactionOfButtons(sent[0]!.card)
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(bridge.dispatch({ interactionId, outcome: 'approved', formValue: undefined, operatorOpenId: 'ou_1' }).card).toBeUndefined()
  })

  it('updates settled cards through the configured platform template', async () => {
    const live = settings()
    live.interactionCards = { ...live.interactionCards, approval: { ...live.interactionCards.approval, settledTemplateId: 'AAq9' } }
    const { bridge, ctx, sent } = makeBridge(live)
    const owner = agent()
    bridge.mountAnswerers(ctx, owner)
    bridge.setAnchor(owner.session.id, 'om_1')
    const pending = ctx.waterfall('approval/request', approvalRequest(owner), () => Promise.resolve('unavailable' as ApprovalOutcome))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const response = bridge.dispatch({ interactionId: interactionOfButtons(sent[0]!.card), outcome: 'rejected', formValue: undefined, operatorOpenId: 'ou_1' })
    await expect(pending).resolves.toBe('rejected')
    expect(response.card).toEqual({ type: 'template', data: { template_id: 'AAq9', template_variable: { outcome: 'rejected', decidedBy: 'ou_1' } } })
  })
})
