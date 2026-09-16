/** U05: the feishu_deliver tool — registration and path validation (exists, non-empty, size). */

import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DELIVER_TOOL_NAME, apply as applyDeliverTool } from '../src/deliver.ts'

/** Tool definitions the deliver tool registered on a capture context. */
let registeredTools: { name: string; execute: (args: { paths: string[] }, exec: unknown) => Promise<unknown> }[] = []

/** One context whose tools.register captures definitions. */
function toolCaptureContext(): { tools: { register(definition: never): void } } {
  registeredTools = []
  return { tools: { register: (definition: never) => { registeredTools.push(definition) } } }
}

/** The single registered deliver tool definition. */
function deliverTool() {
  const tool = registeredTools.find(tool => tool.name === DELIVER_TOOL_NAME)
  expect(tool).toBeDefined()
  return tool!
}

/** Root for deliver-tool validation fixtures. */
let fixtureRoot: string | undefined

afterEach(async () => {
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = undefined
})

describe('feishu_deliver tool', () => {
  it('registers under its declared name', () => {
    applyDeliverTool(toolCaptureContext() as never)
    expect(deliverTool().name).toBe(DELIVER_TOOL_NAME)
  })

  it('accepts deliverable files and rejects missing, empty, oversized, and non-file paths', async () => {
    applyDeliverTool(toolCaptureContext() as never)
    fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-feishu-deliver-'))
    const good = join(fixtureRoot, 'report.md')
    const empty = join(fixtureRoot, 'empty.txt')
    const huge = join(fixtureRoot, 'huge.bin')
    const missing = join(fixtureRoot, 'missing.pdf')
    await writeFile(good, 'deliverable')
    await writeFile(empty, '')
    await writeFile(huge, 'x')
    await truncate(huge, 30 * 1024 * 1024 + 1)
    const result = await deliverTool().execute({ paths: [good, empty, huge, missing, fixtureRoot] }, undefined) as {
      accepted: { path: string; name: string; bytes: number }[]
      rejected: { path: string; reason: string }[]
    }
    expect(result.accepted).toEqual([{ path: good, name: 'report.md', bytes: 11 }])
    expect(result.rejected.map(entry => entry.path)).toEqual([empty, huge, missing, fixtureRoot])
    expect(result.rejected[0]?.reason).toContain('empty')
    expect(result.rejected[1]?.reason).toContain('30 MB')
  })
})
