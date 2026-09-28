/** C05: the feishu_deliver tool — registration, path validation, and card-header validation with send-time normalization. */

import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DELIVER_TOOL_NAME, apply as applyDeliverTool } from '../src/deliver.ts'
import { extractCards } from '../src/settlement.ts'

/** Tool definitions the deliver tool registered on a capture context. */
let registeredTools: { name: string; execute: (args: { paths?: string[]; cards?: unknown[] }, exec: unknown) => Promise<unknown> }[] = []

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

  it('accepts plain-string card headers and rejects headers no normalization can save', async () => {
    applyDeliverTool(toolCaptureContext() as never)
    const result = await deliverTool().execute({
      paths: [],
      cards: [
        { elements: [{ tag: 'div', text: 'ok' }], header: { title: 'string title self-heals at send' } },
        { elements: [{ tag: 'div', text: 'ok' }], header: 'plain header string' },
        { elements: [{ tag: 'div', text: 'ok' }], header: ['not', 'an', 'object'] },
        { elements: [{ tag: 'div', text: 'ok' }], header: { title: 42 } },
        { noElementsHere: true },
      ],
    }, undefined) as {
      acceptedCards: number
      rejectedCards: number
      rejectedCardReasons: string[]
    }
    expect(result.acceptedCards).toBe(2)
    expect(result.rejectedCards).toBe(3)
    expect(result.rejectedCardReasons[0]).toContain('"header" must be an object')
    expect(result.rejectedCardReasons[1]).toContain('"header.title" must be')
    expect(result.rejectedCardReasons[2]).toContain('"elements"')
  })

  it('normalizes declared string titles onto the plain_text object Feishu requires, without mutating the log', () => {
    const stringTitle = { elements: [{ tag: 'div', text: 'body' }], header: { title: '🚨 P0 研判摘要' } }
    const stringHeader = { elements: [{ tag: 'div', text: 'body' }], header: '整体结论' }
    const cardTwoPointOh = { schema: '2.0', body: { elements: [{ tag: 'div' }] } }
    const arrayHeader = { elements: [{ tag: 'div', text: 'body' }], header: ['junk'] }
    const events: SessionEvent[] = [{
      type: 'tool/call',
      seq: 0,
      time: 0,
      data: { name: DELIVER_TOOL_NAME, arguments: JSON.stringify({ cards: [stringTitle, stringHeader, cardTwoPointOh, arrayHeader] }) },
    } as SessionEvent]
    const sent = extractCards(events, 0)
    expect(sent).toHaveLength(3)
    expect(sent[0]?.header).toEqual({ title: { tag: 'plain_text', content: '🚨 P0 研判摘要' } })
    expect(sent[1]?.header).toEqual({ title: { tag: 'plain_text', content: '整体结论' } })
    expect(sent[2]?.header).toBeUndefined()
    // The declared originals stay untouched: the session log owns them.
    expect(stringTitle.header).toEqual({ title: '🚨 P0 研判摘要' })
    expect(stringHeader.header).toBe('整体结论')
    expect(arrayHeader.header).toEqual(['junk'])
  })
})
