/**
 * T20 (POC 用例「闭环伪成功」): 模型声称处理完成，但工单未写/验证失败
 * → 状态保持待处理/待复核，不展示已关闭。
 * Cover: the session log — not the model's own narration — is the source of
 * truth for closure. Assistant text claiming completion without a durable
 * deliver declaration produces no business-side closure artifacts.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionIdForChat } from '../src/conversation.ts'
import { message, reply, replyFile, resetStubs, router, settings, stubbedContext, whenIdleBehaviors } from './poc-stubs.ts'

let contexts: ReturnType<typeof stubbedContext>[] = []

afterEach(() => {
  resetStubs()
  contexts.forEach(context => void context.fiber.dispose())
  contexts = []
})

/** One assistant narration event with arbitrary claim text. */
function narration(events: SessionEvent[], text: string): void {
  events.push({
    type: 'assistant/message',
    seq: events.length,
    time: 0,
    data: { turn: 0, step: 0, message: { content: [{ type: 'text', text }] } },
  } as SessionEvent)
}

describe('T20 闭环伪成功', () => {
  it('模型文本声称“已完成并发送文件”，但日志无 deliver 声明 → 不产生任何投递', async () => {
    const ctx = stubbedContext()
    contexts.push(ctx)
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      narration(events, '已完成处理，工单已关闭，两个文件已发送给你。')
    })
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    await new Promise((resolve) => { setTimeout(resolve, 30) })

    // 文本回复照发（含模型的声称），但投递以 tool/call 声明为准：没有任何文件消息
    expect(reply).toHaveBeenCalledWith('om_1', expect.stringContaining('已完成'))
    expect(replyFile).not.toHaveBeenCalled()
  })

  it('文本声称 + 存在 deliver 声明 → 仅投递声明过的文件，声明之外不补', async () => {
    const ctx = stubbedContext()
    contexts.push(ctx)
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      events.push({
        type: 'tool/call',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, callId: 'c1', name: 'feishu_deliver', arguments: JSON.stringify({ paths: ['/tmp/declared.pdf'] }) },
      } as SessionEvent)
      narration(events, '已发送 declared.pdf 与 report.xlsx 两个文件，工单关闭。')
    })
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(replyFile).toHaveBeenCalledOnce() })

    // 只投递日志声明的 declared.pdf；文本里多说的 report.xlsx 不构成证据
    expect(replyFile).toHaveBeenCalledWith('om_1', { name: 'declared.pdf', path: '/tmp/declared.pdf' })
    expect(replyFile).toHaveBeenCalledTimes(1)
  })

  it('声明存在但文件在结算时已消失 → 上传失败可观测，文本不被当作成功回执', async () => {
    const ctx = stubbedContext()
    contexts.push(ctx)
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      events.push({
        type: 'tool/call',
        seq: events.length,
        time: 0,
        data: { turn: 0, step: 0, callId: 'c1', name: 'feishu_deliver', arguments: JSON.stringify({ paths: ['/tmp/vanished.pdf'] }) },
      } as SessionEvent)
      narration(events, '处理完成。')
    })
    replyFile.mockRejectedValueOnce(new Error('ENOENT: no such file'))
    router(ctx, settings()).accept(message())
    await vi.waitFor(() => { expect(replyFile).toHaveBeenCalledOnce() })
    await new Promise((resolve) => { setTimeout(resolve, 30) })

    // 投递尝试失败被记录且隔离：回合以文本正常结束，不误报失败通知，也不谎称文件已送达
    expect(replyFile).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith('om_1', '处理完成。')
    expect(reply).toHaveBeenCalledTimes(1)
  })
})
