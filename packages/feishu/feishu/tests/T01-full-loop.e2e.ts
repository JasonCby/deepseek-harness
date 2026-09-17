/**
 * T01 (POC 用例「正常闭环」, e2e): 告警→认领→查资料→建议→提交→复核。
 * Pass: 三个回合落在同一持久会话；每轮的文件交付都经 feishu_deliver 声明；
 * 报告状态沿「研判→已认领→已关单」推进且终态写明复核达标。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountE2E, message, writeDrillFixtures, glmKeyFromCredentialStore, type E2EHarness } from './e2e-harness.ts'

let live: E2EHarness | undefined
let workdir: string | undefined

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-feishu-t01-e2e-'))
  await writeDrillFixtures(workdir)
  live = await mountE2E(workdir)
})

afterEach(async () => {
  await live?.ctx.fiber.dispose()
  live = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

describe.skipIf(glmKeyFromCredentialStore() === undefined)('T01 正常闭环 (real model)', () => {
  it('告警→研判交付→认领更新→复核关单，三回合同一会话推进报告状态', async () => {
    const harness = live!
    const root = workdir!
    const report = () => readFile(`${root}/alert-report.md`, 'utf8')

    // 回合一：告警 → 查资料 → 建议 → 提交（研判报告）
    harness.subject.accept(message({
      messageId: 'om_t01_alert',
      text: '【P0 告警研判】ALT-E2E-001：prod-web-nginx-03 5xx 38.2%。'
        + `现场数据：${root}/active_alerts.json、${root}/asset_inventory.csv、${root}/runbook.md。`
        + '按手册研判后，把报告（时间线/根因/责任人/处置/关单标准）'
        + `写到 ${root}/alert-report.md 并用 feishu_deliver 交付。`,
    }))
    await harness.settled(1)
    const round1 = await report()
    expect(round1).toContain('prod-order-api')
    expect(round1).toContain('王悦')
    expect(harness.replyFile).toHaveBeenCalledTimes(1)

    // 回合二：责任人认领 → 报告更新为已认领 → 重新交付
    harness.subject.accept(message({
      messageId: 'om_t01_claim',
      text: '我是王悦（订单交易组 oncall），认领 ALT-E2E-001：已对 prod-order-api 扩容 4→8 实例并限流。'
        + `请把 ${root}/alert-report.md 的状态更新为已认领，并将更新后的报告再次交付。`,
    }))
    await harness.settled(2)
    const round2 = await report()
    expect(round2).toContain('认领')
    expect(harness.replyFile).toHaveBeenCalledTimes(2)

    // 回合三：复核达标 → 确认关单 → 最终交付
    harness.subject.accept(message({
      messageId: 'om_t01_close',
      text: '复核（复核人：陈炳宇）：当前 5xx 0.4%、order-api 队列 60、稳定 6 分钟，满足关单标准。'
        + `请确认关单，更新 ${root}/alert-report.md 终态并交付。`,
    }))
    await harness.settled(3)
    const round3 = await report()
    expect(round3).toContain('关单')
    expect(harness.replyFile).toHaveBeenCalledTimes(3)

    // 三个回合全部落在同一持久会话：一次会话创建，三轮用户消息
    const events = harness.events()
    expect(events.filter(event => event.type === 'user/message').length).toBeGreaterThanOrEqual(3)
    const delivered = events
      .filter(event => event.type === 'tool/call' && event.data.name === 'feishu_deliver')
    expect(delivered.length).toBeGreaterThanOrEqual(3)

    // 每轮回复都不是失败通知
    for (const call of harness.reply.mock.calls) {
      expect(call[1]).not.toBe('processing failed')
    }
  }, 600_000)
})
