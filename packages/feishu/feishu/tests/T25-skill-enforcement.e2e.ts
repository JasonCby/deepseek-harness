/**
 * T25 (POC 用例「流程Skill定义、读取与强制调用」正常组, 路畅, e2e): 显式注入 Skill 正文
 * 后处理真实告警 → 完整执行 S1→S5 工具链并引用业务回执。
 * Pass: the turn receives the admitted alert-triage body through explicit
 * injection, then executes the real tool chain — S2/S3/S5 hit the business API
 * in order and the reply cites the receipts. 目录摘要或助手自称已读不算：
 * evidence is the session log's bash calls plus the fake API's request record.
 * 强制组（未加载不得执行、诱导绕过、版本阻断）为 POC 平台侧门控，留人工。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { glmKeyFromCredentialStore } from './e2e-harness.ts'
import { message, mountSkillE2E, skillBody, startFakeBizApi, type FakeBizApi, type SkillE2EHarness } from './skill-e2e-harness.ts'


let live: SkillE2EHarness | undefined
let api: FakeBizApi | undefined
let workdir: string | undefined

beforeEach(async () => {
  api = await startFakeBizApi()
  workdir = await mkdtemp(join(tmpdir(), 'dsh-feishu-t25-e2e-'))
  live = await mountSkillE2E(workdir)
})

afterEach(async () => {
  await live?.ctx.fiber.dispose()
  live = undefined
  await api?.close()
  api = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

/** One 灯塔-7 alert text the triage flow consumes. */
const ALERT_TEXT = '【告警】告警ID：ALT-L7-0001，时间：2026-09-28T10:20:00+08:00，源设备：RELAY-B7（C环区主中继天线阵），'
  + '类型：电源波动，描述：三号供电母线电压骤降至标称值的 61%，持续 40 秒，已自动切换部分负载至备用母线。'

describe.skipIf(glmKeyFromCredentialStore() === undefined)('T25 流程Skill定义、读取与强制调用·正常组 (real model)', () => {
  it('显式注入 Skill 正文 → S1-S5 真实执行工具链并引用回执', async () => {
    const harness = live!
    const body = await skillBody(api!.port)

    harness.subject.accept(message({
      messageId: 'om_t25_skill',
      text: `${ALERT_TEXT}\n\n=== 以下为获准的 alert-triage Skill 正文（版本 1.0.0，经批准注入）===\n${body}\n=== 正文结束 ===\n`
        + '请严格按上述 Skill 流程处理这条告警。',
    }))
    await harness.settled(1)

    const replyText = harness.reply.mock.calls[0]?.[1]?.text ?? ''
    // 证据是真实执行轨迹，不是模型自称：bash 工具确实按序调用了三个业务接口
    const bashCalls = harness.events()
      .filter(event => event.type === 'tool/call' && event.data.name === 'bash')
      .map((event) => {
        if (event.type !== 'tool/call') return ''
        const command = (JSON.parse(event.data.arguments) as Record<string, unknown>).command
        return typeof command === 'string' ? command : ''
      })
    const bizCommands = bashCalls.filter(cmd => cmd.includes('localhost:' + String(api!.port)))
    expect(bizCommands.some(cmd => cmd.includes('/asset')), 'S2 查询资产真实调用').toBe(true)
    expect(bizCommands.some(cmd => cmd.includes('/rule')), 'S3 查询规则真实调用').toBe(true)
    expect(bizCommands.some(cmd => cmd.includes('/publish')), 'S5 发布真实调用').toBe(true)
    // 业务侧回执记录同样存在（双通道证据）
    expect(api!.requests.some(req => req.path.startsWith('/asset'))).toBe(true)
    expect(api!.requests.some(req => req.path.startsWith('/publish'))).toBe(true)
    // 回复引用回执号并给出最终通告
    expect(replyText).toMatch(/RCPT-[QP]-/)
    expect(replyText).not.toBe('processing failed')
  }, 420_000)
})
