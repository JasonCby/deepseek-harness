/**
 * U03 (POC 用例「多轮补充」, 王悦): 第一轮补充仍不足，继续要求第二字段
 * → 两次请求代次可区分；已提供信息不丢；旧请求不可覆盖新回答。
 * Cover: multi-question forms project one field per question (each round can
 * ask for the next missing field), structured answers carry every provided
 * value, and stale interactions never overwrite a newer answer.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeishuSettings } from '../src/config.ts'
import { buildQuestionCard, QUESTION_FIELD_PREFIX } from '../src/interaction-card.ts'
import { InteractionBridge, type CardActionResponse } from '../src/interaction.ts'
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
      question: { title: 'Please answer', submitLabel: 'Submit' },
    },
  }
}

/** One card the bridge sent, as the fake reply sender recorded it. */
interface SentCard {
  readonly messageId: string
  readonly card: Record<string, unknown>
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

describe('U03 多轮补充', () => {
  it('多问题表单按题型投影字段：一轮可要求多个缺失字段', () => {
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

  it('表单提交的结构化应答保留全部已填信息并更新绑定卡片', async () => {
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
    // 已提供信息不丢：三个字段的答案全部回到模型
    expect(answer.answers).toEqual([
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: ['X', 'Y'] },
      { id: 'q3', selected: [], custom: 'hello' },
    ])
    // 原绑定卡片原地更新为汇总
    const summary = ((response.card as { data: { elements: { content: string }[] } }).data.elements[0]!.content)
    expect(summary).toContain('Pick one: A')
    expect(summary).toContain('Pick many: X, Y')
    expect(summary).toContain('Say something: hello')
  })

  it('过期与畸形点击不覆盖新回答，回调不失败', () => {
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
})
