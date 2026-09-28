/**
 * T14 (POC 用例「多轮隔离」, 王悦): 同时处理两事件，交错补充资料
 * → 上下文、证据、结果不串单。
 * Cover: topic threads route to their own session beside the chat's main
 * stream, one bot-opened topic per main-stream message, and the degradation
 * path when topic opening fails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionIdForChat, sessionIdForThread } from '../src/conversation.ts'
import {
  followups,
  isolateHome,
  message,
  reply,
  resetC10,
  restoreHome,
  router,
  settings,
  stubbedContext,
} from './c10-stubs.ts'

let homeDir: string

beforeEach(() => {
  homeDir = isolateHome()
})

afterEach(() => {
  restoreHome(homeDir)
  resetC10()
})

describe('T14 多轮隔离', () => {
  it('话题消息路由到独立 session，与主消息流并行不串', async () => {
    const ctx = stubbedContext()
    const create = (ctx.get('agents') as unknown as { create: ReturnType<typeof vi.fn> }).create
    const title = (ctx.get('sessionTitle') as unknown as { rename: ReturnType<typeof vi.fn> }).rename
    const subject = router(ctx, settings())
    subject.accept(message({ messageId: 'om_main' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    subject.accept(message({ messageId: 'om_t1', threadId: 'omt_1' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    subject.accept(message({ messageId: 'om_t1b', threadId: 'omt_1' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(3) })
    // 主流一个会话、话题一个会话：上下文与结果不串单
    expect(create).toHaveBeenCalledTimes(2)
    expect(followups.get(sessionIdForChat('oc_1'))).toHaveBeenCalledTimes(1)
    expect(followups.get(sessionIdForThread('oc_1', 'omt_1'))).toHaveBeenCalledTimes(2)
    expect(title).toHaveBeenCalledWith(expect.anything(), 'Feishu chat oc_1')
    expect(title).toHaveBeenCalledWith(expect.anything(), 'Feishu chat oc_1 topic omt_1')
  })

  it('replyInThread 开启时主消息流每条消息各开一个话题', async () => {
    const ctx = stubbedContext()
    const opened: { messageId: string; summary: string }[] = []
    const subject = router(ctx, { ...settings(), replyInThread: true })
    subject.setTopicOpener({
      open: async (messageId, summary) => {
        opened.push({ messageId, summary })
        return { leadMessageId: 'om_lead', threadId: 'omt_new' }
      },
    })
    subject.accept(message({ text: 'multi\nline   question' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(opened).toEqual([{ messageId: 'om_1', summary: 'multi line question' }])
    expect(reply).toHaveBeenCalledWith('om_lead', expect.objectContaining({ kind: 'text' }))
    expect(followups.get(sessionIdForThread('oc_1', 'omt_new'))).toHaveBeenCalledOnce()
  })

  it('话题内续答不再重复开题', async () => {
    const ctx = stubbedContext()
    let opens = 0
    const subject = router(ctx, { ...settings(), replyInThread: true })
    subject.setTopicOpener({
      open: async () => {
        opens += 1
        return { leadMessageId: 'om_lead', threadId: 'omt_x' }
      },
    })
    subject.accept(message({ messageId: 'om_t', threadId: 'omt_1' }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(opens).toBe(0)
    expect(reply).toHaveBeenCalledWith('om_t', expect.objectContaining({ kind: 'text' }))
    expect(followups.get(sessionIdForThread('oc_1', 'omt_1'))).toHaveBeenCalledOnce()
  })

  it('开题失败降级为就地回复，不丢轮次', async () => {
    const ctx = stubbedContext()
    const subject = router(ctx, { ...settings(), replyInThread: true })
    subject.setTopicOpener({
      open: async () => { throw new Error('topic refused') },
    })
    subject.accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(reply).toHaveBeenCalledWith('om_1', expect.objectContaining({ kind: 'text' }))
    expect(followups.get(sessionIdForChat('oc_1'))).toHaveBeenCalledOnce()
  })
})
