/**
 * T11 (POC 用例「工具失败」): 查询超时/权限拒绝/错误字段/缺失信息
 * → 分类处理，停止依赖错误信息的动作。
 * Cover: the plugin-side tool surfaces classify their failures — attachment
 * download and store errors stop the turn before the model sees broken input,
 * and deliver-tool validation rejects per-path with a reason instead of a crash.
 */

import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionIdForChat } from '../src/conversation.ts'
import { DELIVER_TOOL_NAME, apply as applyDeliverTool } from '../src/deliver.ts'
import { message, reply, resetStubs, router, saveFileStream, settings, stubbedContext, fetchResourceMock, followups } from './poc-stubs.ts'

let contexts: ReturnType<typeof stubbedContext>[] = []
let fixtureRoot: string | undefined

afterEach(async () => {
  resetStubs()
  contexts.forEach(context => void context.fiber.dispose())
  contexts = []
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = undefined
})

describe('T11 工具失败', () => {
  it.each([
    ['资源查询超时', new Error('fetch failed: ETIMEDOUT')],
    ['资源权限拒绝', Object.assign(new Error('feishu resource failed with code 403'), { code: 403 })],
  ])('附件%s → 停止依赖错误数据：回合失败通知，模型不收到损坏输入', async (_label, failure) => {
    const ctx = stubbedContext()
    contexts.push(ctx)
    fetchResourceMock.mockRejectedValueOnce(failure)
    router(ctx, settings()).accept(message({
      text: '',
      attachments: [{ kind: 'file', key: 'file_v3_x', name: 'alert.png' }],
    }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_1', 'processing failed') })

    // 停止依赖错误信息：未写入存储、未提交模型（ensureAgent 先于下载执行，spy 存在但未被调用）
    expect(saveFileStream).not.toHaveBeenCalled()
    expect(followups.get(sessionIdForChat('oc_1'))).not.toHaveBeenCalled()
  })

  it('存储写入失败 → 同样分类为回合失败，不提交半成品', async () => {
    const ctx = stubbedContext()
    contexts.push(ctx)
    saveFileStream.mockRejectedValueOnce(new Error('EIO: store write failed'))
    router(ctx, settings()).accept(message({
      text: '',
      attachments: [{ kind: 'image', key: 'img_v3_y' }],
    }))
    await vi.waitFor(() => { expect(reply).toHaveBeenCalledWith('om_1', 'processing failed') })
    expect(followups.get(sessionIdForChat('oc_1'))).not.toHaveBeenCalled()
  })

  it('deliver 工具对缺失/超限/空文件逐路径给出分类原因，不整体崩溃', async () => {
    const registered: { name: string; execute: (args: { paths: string[] }, exec: unknown) => Promise<unknown> }[] = []
    const capture = { tools: { register: (definition: never) => { registered.push(definition) } } }
    applyDeliverTool(capture as never)
    const tool = registered.find(tool => tool.name === DELIVER_TOOL_NAME)!
    expect(tool).toBeDefined()

    fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-feishu-t11-'))
    const missing = join(fixtureRoot, 'gone.pdf')
    const empty = join(fixtureRoot, 'empty.bin')
    const huge = join(fixtureRoot, 'huge.bin')
    await writeFile(empty, '')
    await writeFile(huge, 'x')
    await truncate(huge, 30 * 1024 * 1024 + 1)

    const result = await tool.execute({ paths: [missing, empty, huge] }, undefined) as {
      accepted: unknown[]
      rejected: { path: string; reason: string }[]
    }
    // 分类处理：三类失败各自带原因返回，工具本身不抛
    expect(result.accepted).toEqual([])
    expect(result.rejected.map(entry => entry.path)).toEqual([missing, empty, huge])
    expect(result.rejected[0]?.reason).not.toContain('Error')
    expect(result.rejected[1]?.reason).toBe('empty file')
    expect(result.rejected[2]?.reason).toBe('over the 30 MB upload limit')
  })
})
