/**
 * T02 (POC 用例「模型不可用降级」, 研究项): 模型超时不可启动
 * → 原始告警照常推送，可人工处理，不误关单。
 * Cover: when the model turn cannot run at all, the chat still receives an
 * explicit failure notice (the manual-handling entry), no closure artifact is
 * produced, and the degradation does not poison the session for later turns.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionIdForChat } from '../src/conversation.ts'
import { message, reply, replyFile, resetStubs, router, settings, stubbedContext, whenIdleBehaviors, followups } from './poc-stubs.ts'

let contexts: ReturnType<typeof stubbedContext>[] = []

afterEach(() => {
  resetStubs()
  contexts.forEach(context => void context.fiber.dispose())
  contexts = []
})

describe('T02 模型不可用降级', () => {
  it('模型超时不可用 → 发出失败通知（人工处理入口），不投递、不产生成功回执', async () => {
    const ctx = stubbedContext()
    contexts.push(ctx)
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async () => {
      throw new Error('model request timed out after 30000ms')
    })
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_1', 'processing failed') })
    await new Promise((resolve) => { setTimeout(resolve, 30) })

    // 不误关单：无文件投递、无成功文本
    expect(reply).toHaveBeenCalledTimes(1)
    expect(replyFile).not.toHaveBeenCalled()
  })

  it('降级不连坐：模型恢复后的下一条告警在同一会话继续正常处理', async () => {
    const ctx = stubbedContext()
    contexts.push(ctx)
    const sessionId = sessionIdForChat('oc_1')
    let broken = true
    whenIdleBehaviors.set(sessionId, async (events) => {
      if (broken) throw new Error('model unavailable')
      events.push({
        type: 'assistant/message',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: '研判完成：CPU 告警已确认。' }] } },
      } as SessionEvent)
    })

    const subject = router(ctx, settings())
    subject.accept(message({ messageId: 'om_alert_1' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_alert_1', 'processing failed') })

    broken = false
    subject.accept(message({ messageId: 'om_alert_2' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_alert_2', '研判完成：CPU 告警已确认。') })
    // 会话存活且两条告警都留痕：人工可在原会话补处理
    expect(followups.get(sessionId)).toHaveBeenCalledTimes(2)
  })
})
