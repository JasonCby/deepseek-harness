/**
 * T04 (POC 用例「同对象新告警」): 同资产不同发生时间/事件ID → 不被错误合并丢弃；关联展示有依据。
 * Cover: two distinct message identities on one chat (one asset) each get their
 * own turn, while the chat keeps its single session — the correlation anchor.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionIdForChat } from '../src/conversation.ts'
import { message, reply, resetStubs, router, servedHandles, settings, stubbedContext, followups } from './poc-stubs.ts'

let contexts: ReturnType<typeof stubbedContext>[] = []

afterEach(() => {
  resetStubs()
  contexts.forEach(context => void context.fiber.dispose())
  contexts = []
})

describe('T04 同对象新告警', () => {
  it('同 chat 不同事件ID各自成单，不被合并丢弃', async () => {
    const ctx = stubbedContext()
    contexts.push(ctx)
    const sessionId = sessionIdForChat('oc_1')
    const subject = router(ctx, settings())

    subject.accept(message({ messageId: 'om_alert_0900', text: '告警A：资产asset-a 09:00 CPU 95%' }))
    subject.accept(message({ messageId: 'om_alert_1100', text: '告警B：资产asset-a 11:00 CPU 98%' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })

    // 两个事件各自提交、各自回复：不丢、不并
    expect(followups.get(sessionId)).toHaveBeenCalledTimes(2)
    const texts = followups.get(sessionId)?.mock.calls.map(call => call[0]?.content.at(-1)?.text ?? '') ?? []
    expect(texts[0]).toContain('09:00')
    expect(texts[1]).toContain('11:00')
  })

  it('新事件复用同一会话：关联展示有依据', async () => {
    const ctx = stubbedContext()
    contexts.push(ctx)
    const sessionId = sessionIdForChat('oc_1')
    const subject = router(ctx, settings())

    subject.accept(message({ messageId: 'om_alert_0900' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    subject.accept(message({ messageId: 'om_alert_1100' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })

    // 同资产(同chat)的全部事件落在同一 session 上，业务侧可据此关联展示
    expect(servedHandles.size).toBe(1)
    expect(servedHandles.has(sessionId)).toBe(true)
    expect((servedHandles.get(sessionId)?.agent.session.snapshotEvents() as { type: string }[]).filter(e => e.type === 'user/message').length).toBe(2)
  })
})
