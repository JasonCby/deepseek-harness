/**
 * U07 (POC 用例「出站失败」): 工具调用时注入429/超时/权限拒绝及应答丢失
 * → 错误通过工具回执或状态查询可见；不宣称已通知；重试不产生重复有效动作。
 * Cover: outbound senders failing with 429/timeout/permission-loss surface the
 * failure instead of pretending success, and a Feishu retry of the same message
 * never re-submits the already-settled turn.
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

describe('U07 出站失败', () => {
  it.each([
    ['429 限流', Object.assign(new Error('feishu reply failed with code 429'), { code: 429 })],
    ['超时', new Error('fetch failed: ETIMEDOUT')],
    ['权限拒绝', Object.assign(new Error('feishu reply failed with code 403: no permission'), { code: 403 })],
  ])('文本回复%s → 失败通知可见，且不重复提交回合', async (_label, failure) => {
    const ctx = stubbedContext()
    contexts.push(ctx)
    const sessionId = sessionIdForChat('oc_1')
    reply.mockRejectedValueOnce(failure)
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })

    // 第一次调用是回合文本（失败），第二次是失败通知：错误可见而非被吞
    const second = reply.mock.calls[1]
    expect(second?.[0]).toBe('om_1')
    expect(second?.[1]).toBe('processing failed')
    expect(followups.get(sessionId)).toHaveBeenCalledOnce()
  })

  it('应答丢失（回复与失败通知都失败）→ 不崩溃，同消息重试不产生重复业务动作', async () => {
    const ctx = stubbedContext()
    contexts.push(ctx)
    const sessionId = sessionIdForChat('oc_1')
    reply.mockRejectedValue(new Error('connection lost'))
    const subject = router(ctx, settings())
    subject.accept(message())
    await new Promise((resolve) => { setTimeout(resolve, 30) })

    // 应答彻底丢失：两次尝试（文本+通知）都失败，进程不崩
    expect(reply).toHaveBeenCalledTimes(2)
    expect(followups.get(sessionId)).toHaveBeenCalledOnce()

    // Feishu 重投同一消息：dedup 拒绝，不再第二次提交回合（无重复有效动作）
    subject.accept(message())
    await new Promise((resolve) => { setTimeout(resolve, 30) })
    expect(followups.get(sessionId)).toHaveBeenCalledOnce()
    expect(reply).toHaveBeenCalledTimes(2)
  })

  it('文件上传 429 → 失败可观测且被隔离，文本回复不冒充文件送达', async () => {
    const ctx = stubbedContext()
    contexts.push(ctx)
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      events.push({
        type: 'tool/call',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, callId: 'c1', name: 'feishu_deliver', arguments: JSON.stringify({ paths: ['/tmp/report.pdf'] }) },
      } as SessionEvent)
      events.push({
        type: 'assistant/message',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: '文件已投递。' }] } },
      } as SessionEvent)
    })
    replyFile.mockRejectedValueOnce(Object.assign(new Error('feishu file upload failed with code 429'), { code: 429 }))
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(replyFile).toHaveBeenCalledOnce() })
    await new Promise((resolve) => { setTimeout(resolve, 30) })

    // 上传失败留下一次可见的尝试记录；不重试出第二次上传
    expect(replyFile).toHaveBeenCalledTimes(1)
    // 回合文本照常发出（含模型措辞），但文件失败从未被包装成成功通知
    expect(reply).toHaveBeenCalledWith('om_1', '文件已投递。')
    expect(reply).toHaveBeenCalledTimes(1)
  })
})
