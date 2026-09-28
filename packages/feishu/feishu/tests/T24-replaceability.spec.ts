/**
 * T24 (POC 用例「可替换性」, 王悦): 替换一个业务工具实现或通知模板
 * → 不改Harness核心；回归T01/T11/T12通过。
 * Cover: card templates are pure configuration — platform and builder-local
 * entries render without core changes, and a misconfigured or refused template
 * degrades loudly instead of losing the answer.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionIdForChat } from '../src/conversation.ts'
import type { FeishuSettings } from '../src/config.ts'
import {
  isolateHome,
  message,
  reply,
  resetC10,
  restoreHome,
  router,
  settings,
  stubbedContext,
  whenIdleBehaviors,
} from './c10-stubs.ts'

let homeDir: string

beforeEach(() => {
  homeDir = isolateHome()
})

afterEach(() => {
  restoreHome(homeDir)
  resetC10()
})

/** Seed one workflow turn whose tool-result meta carries the template variables. */
function workflowTurn(events: SessionEvent[], meta: unknown): void {
  events.push({ type: 'tool/call', seq: events.length, time: 0, data: { turn: 0, step: 0, callId: 'c1', name: 'workflow', arguments: '{}' } } as SessionEvent)
  events.push({ type: 'tool-workflow/run-start', seq: events.length, time: 0, data: { runId: 'r1', name: 'n' } } as SessionEvent)
  if (meta !== undefined) {
    events.push({
      type: 'tool/result', seq: events.length, time: 0,
      data: { turn: 0, step: 0, message: { id: 'm4', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }], role: 'user' }, meta },
    } as unknown as SessionEvent)
  }
  events.push({
    type: 'assistant/message', seq: events.length, time: 0,
    data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'workflow done' }] } },
  } as SessionEvent)
}

describe('T24 可替换性', () => {
  it('替换为平台模板：workflow 回合按绑定渲染，核心零改动', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      workflowTurn(events, { runId: 'r1', name: 'alarm-report', result: { reply: 'handled' } })
    })
    const live: FeishuSettings = {
      ...settings(),
      replyForm: 'auto',
      cardTemplates: [{
        name: 'alarm',
        bindTool: 'workflow',
        templateId: 'AAq1',
        variables: {
          who: { from: 'context', key: 'senderOpenId', required: true },
          reply: { from: 'tool-result', path: 'result.reply', required: true },
        },
      }],
    }
    router(ctx, live).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(reply).toHaveBeenCalledWith('om_1', {
      kind: 'template',
      templateId: 'AAq1',
      variables: { who: 'ou_1', reply: 'handled' },
    })
  })

  it('替换为本地多语言卡片导出：归一化为规范 1.0 渲染', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      workflowTurn(events, { result: { reply: 'handled' } })
    })
    const live: FeishuSettings = {
      ...settings(),
      replyForm: 'auto',
      cardTemplates: [{
        name: 'alarm',
        bindTool: 'workflow',
        card: {
          config: { update_multi: true },
          i18n_elements: { zh_cn: [{ tag: 'markdown', content: '任务完成:{{summary}}' }] },
          i18n_header: { zh_cn: { title: { tag: 'plain_text', content: '告警' }, template: 'red' } },
        },
        variables: { summary: { from: 'tool-result', path: 'result.reply', required: true } },
      }],
    }
    router(ctx, live).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(reply).toHaveBeenCalledWith('om_1', {
      kind: 'localCard',
      card: {
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: '告警' }, template: 'red' },
        elements: [{ tag: 'markdown', content: '任务完成:handled' }],
      },
    })
  })

  it('模板变量不可解析时大声降级为 markdown 卡片', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      workflowTurn(events, undefined)
    })
    const live: FeishuSettings = {
      ...settings(),
      replyForm: 'auto',
      cardTemplates: [{
        name: 'alarm',
        bindTool: 'workflow',
        templateId: 'AAq1',
        variables: { reply: { from: 'tool-result', path: 'result.reply', required: true } },
      }],
    }
    router(ctx, live).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledOnce() })
    expect(reply.mock.calls[0]?.[1]?.kind).toBe('card')
  })

  it('模板投递被拒后重试为 markdown 卡片，不丢答案', async () => {
    const ctx = stubbedContext()
    const sessionId = sessionIdForChat('oc_1')
    whenIdleBehaviors.set(sessionId, async (events) => {
      workflowTurn(events, { result: { reply: 'handled' } })
    })
    const live: FeishuSettings = {
      ...settings(),
      replyForm: 'auto',
      cardTemplates: [{ name: 'alarm', bindTool: 'workflow', templateId: 'AAq1', variables: {} }],
    }
    reply.mockRejectedValueOnce(new Error('feishu reply failed with code 230099'))
    router(ctx, live).accept(message())
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledTimes(2) })
    expect(reply.mock.calls[0]?.[1]?.kind).toBe('template')
    expect(reply.mock.calls[1]?.[1]?.kind).toBe('card')
  })
})
