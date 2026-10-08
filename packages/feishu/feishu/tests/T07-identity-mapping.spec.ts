/**
 * T07 (POC 用例「身份映射」, 王悦, 研究项): 不同租户同名用户、群内无权限者操作
 * → 根据受验证身份授权，不能凭姓名/卡片参数放行。
 * Cover: the operator identity reaches every authorization-relevant record
 * only through the verified callback channel (`operator.open_id` off the wire
 * payload); values forged inside the card form never impersonate an operator.
 * Tenant isolation and permission matrices are POC-platform concerns.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeishuSettings } from '../src/config.ts'
import { QUESTION_FIELD_PREFIX } from '../src/interaction-card.ts'
import { InteractionBridge, parseCardAction } from '../src/interaction.ts'
import { sessionIdForChat } from '../src/conversation.ts'
import type { ReplyContent, ReplySender } from '../src/reply.ts'

/** Every field of a settings section, writable for live-edit tests. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** One mutable settings section the bridge reads live. */
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
      question: { title: 'Please answer', submitLabel: 'Submit', skipLabel: 'Skip' },
    },
  }
}

/** One card the bridge sent, as the fake reply sender recorded it. */
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('T07 身份映射', () => {
  it('回调载荷的 operator 是唯一身份：表单里伪造的身份键不进入任何授权记录', async () => {
    const { bridge, ctx, sent } = makeBridge(settings())
    const owner = agent()
    bridge.mountAnswerers(ctx, owner)
    bridge.setAnchor(owner.session.id, 'om_1')
    const pending = ctx.waterfall('approval/request', { agent: owner, toolName: 'bash', reason: 'remove build output' }, () => new Promise<ApprovalOutcome>(() => {}))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })

    // 表单值里同时塞了伪造身份键；操作者身份仍取回调载荷的 operator.open_id
    const response = bridge.dispatch({
      interactionId: interactionOfButtons(sent[0]!.card),
      outcome: 'approved',
      formValue: { operator: 'ou_forged', open_id: 'ou_forged', identity: '张三（管理员）' },
      operatorOpenId: 'ou_verified',
    })
    await pending
    const rendered = JSON.stringify(response.card ?? {})
    // 结算卡渲染的是验签身份，不是表单伪造值
    expect(rendered).toContain('ou_verified')
    expect(rendered).not.toContain('ou_forged')
    expect(rendered).not.toContain('张三')
  })

  it('问题表单的应答只映射已注册问题字段：伪造身份键不会成为答案', async () => {
    const { bridge, ctx, sent } = makeBridge(settings())
    const owner = agent()
    bridge.mountAnswerers(ctx, owner)
    bridge.setAnchor(owner.session.id, 'om_1')
    const request: AskUserQuestionRequestEvent = {
      questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
    }
    const pending = ctx.waterfall('user-questions/request', request, () => Promise.resolve({ answers: [] }))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const response = bridge.dispatch({
      interactionId: interactionOfForm(sent[0]!.card),
      outcome: undefined,
      formValue: { [`${QUESTION_FIELD_PREFIX}q1`]: 'A', operator: 'ou_forged' },
      operatorOpenId: 'ou_verified',
    })
    const answer: AskUserQuestionAnswer = await pending
    // 只有已注册问题字段的值回到模型；伪造身份键被丢弃
    expect(answer.answers).toEqual([{ id: 'q1', selected: ['A'] }])
    expect(JSON.stringify(response)).not.toContain('ou_forged')
  })

  it('wire 校验：operator 身份仅从回调载荷的 operator.open_id 解析，畸形即为空', () => {
    expect(parseCardAction({
      action: { value: { interactionId: 'fi-3', outcome: 'approved' } },
      operator: { open_id: 'ou_ok' },
    })?.operatorOpenId).toBe('ou_ok')
    // operator 非对象、open_id 非字符串：身份为空，不回退到任何其他字段
    expect(parseCardAction({
      action: { value: { interactionId: 'fi-4', outcome: 'approved' } },
      operator: { open_id: 12345 },
    })?.operatorOpenId).toBeUndefined()
    expect(parseCardAction({
      action: { value: { interactionId: 'fi-5', outcome: 'approved' }, form_value: { operator: 'ou_forged' } },
      operator: undefined,
    })?.operatorOpenId).toBeUndefined()
  })
})
