/**
 * U01 (POC 用例「Harness发起交互」, e2e): 给出一个关键现场告警，让 Harness
 * 按照顺序执行研判流程，读取不同的数据，输出研判结果。
 * Pass: 真模型驱动真实 read 工具读取全部三份数据，参数与告警一致；
 * 研判结论命中演练数据的正确答案（根因/责任人）；报告经 feishu_deliver 交付。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountE2E, message, writeDrillFixtures, glmKeyFromCredentialStore, type E2EHarness } from './e2e-harness.ts'

let live: E2EHarness | undefined
let workdir: string | undefined

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-feishu-u01-e2e-'))
  await writeDrillFixtures(workdir)
  live = await mountE2E(workdir)
})

afterEach(async () => {
  await live?.ctx.fiber.dispose()
  live = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

describe.skipIf(glmKeyFromCredentialStore() === undefined)('U01 Harness发起交互 (real model)', () => {
  it('告警研判：真实工具读三份数据，结论命中根因与责任人，报告交付', async () => {
    const harness = live!
    const root = workdir!
    harness.subject.accept(message({
      messageId: 'om_u01_alert',
      text: '【P0 告警研判】生产 Nginx 节点 5xx 激增（ALT-E2E-001，prod-web-nginx-03，13:20，5xx 38.2%，p99 4.2s）。'
        + `现场数据：告警明细 ${root}/active_alerts.json、资产与值班表 ${root}/asset_inventory.csv、研判手册 ${root}/runbook.md。`
        + '请按手册顺序研判：先用 read 工具读取全部三份文件，再判定根因资产、给出处置建议与第一责任人，'
        + `最后把研判报告（含时间线、根因、责任人、处置步骤）写到 ${root}/alert-report.md 并用 feishu_deliver 交付。`,
    }))
    await harness.settled(1)

    // 真实注册工具调用：read 覆盖全部三个数据源
    const calls = harness.events().filter(event => event.type === 'tool/call')
    const readTargets = calls
      .map(event => event.type === 'tool/call' ? event.data : undefined)
      .filter(data => data !== undefined && data.name === 'read')
      .map(data => String((JSON.parse(data.arguments) as Record<string, unknown>).file_path))
    for (const fixture of ['active_alerts.json', 'asset_inventory.csv', 'runbook.md']) {
      expect(readTargets.some(path => path.includes(fixture)), `read 覆盖 ${fixture}`).toBe(true)
    }

    // 模型声明投递，且交付的就是研判报告
    expect(calls.some(event => event.type === 'tool/call' && event.data.name === 'feishu_deliver')).toBe(true)
    expect(harness.replyFile).toHaveBeenCalledOnce()
    expect(harness.replyFile.mock.calls[0]?.[1]?.path).toContain('alert-report.md')

    // 报告结论命中演练数据的正确答案：根因=上游订单服务，第一责任人=其 oncall
    const report = await readFile(`${root}/alert-report.md`, 'utf8')
    expect(report).toContain('prod-order-api')
    expect(report).toContain('王悦')

    // 飞书文本回复同样给出正确结论
    const replyText = harness.reply.mock.calls[0]?.[1] ?? ''
    expect(replyText).toContain('prod-order-api')
    expect(replyText).not.toBe('processing failed')
  }, 240_000)
})
