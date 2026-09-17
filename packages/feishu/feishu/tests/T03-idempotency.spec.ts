/**
 * T03 (POC 用例「重复告警幂等验证」): 同一事件ID重复5次 → 只有1个业务事件；通知按约定去重。
 * Cover: the router admits one transport retry burst of the same message identity
 * as exactly one turn — one followup, one reply, one session.
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

describe('T03 重复告警幂等验证', () => {
  it('同一事件ID重复投递5次只产生1个业务事件和1条通知', async () => {
    const ctx = stubbedContext()
    contexts.push(ctx)
    const subject = router(ctx, settings())
    const create = (ctx.get('agents') as unknown as { create: ReturnType<typeof vi.fn> }).create

    for (let i = 0; i < 5; i++) subject.accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    // 等队列彻底排空，确认没有第二轮回调
    await new Promise((resolve) => { setTimeout(resolve, 30) })

    expect(create).toHaveBeenCalledOnce()
    expect(followups.get(sessionIdForChat('oc_1'))).toHaveBeenCalledOnce()
    expect(reply).toHaveBeenCalledOnce()
    expect(servedHandles.size).toBe(1)
  })

  it('同一事件ID在处理完成后再次重投也不再受理', async () => {
    const ctx = stubbedContext()
    contexts.push(ctx)
    const sessionId = sessionIdForChat('oc_1')
    const subject = router(ctx, settings())
    subject.accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    // 回合已结算后的迟到重试：dedup 已认领，不得再提交第二次 followup
    subject.accept(message())
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(followups.get(sessionId)).toHaveBeenCalledOnce()
    expect(reply).toHaveBeenCalledOnce()
  })
})
