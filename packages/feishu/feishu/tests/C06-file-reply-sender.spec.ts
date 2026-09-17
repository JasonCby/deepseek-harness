/** C06: file reply sender — upload once, reply with the returned key, fail loud without one. */

import type { ReadStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileReplySender } from '../src/reply.ts'

/** Root for file-reply fixtures. */
let fixtureRoot: string | undefined

afterEach(async () => {
  if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = undefined
})

describe('createFileReplySender', () => {
  it('uploads once and replies with the returned file key', async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-feishu-filereply-'))
    const deliverable = join(fixtureRoot, 'report.md')
    await writeFile(deliverable, 'deliverable')
    const uploads: { name: string }[] = []
    const replies: { messageId: string; msgType: string; content: string }[] = []
    const client = {
      im: {
        v1: {
          message: {
            reply: async (params: { path: { message_id: string }; data: { msg_type: string; content: string } }) => {
              replies.push({ messageId: params.path.message_id, msgType: params.data.msg_type, content: params.data.content })
              return { code: 0 }
            },
          },
          file: {
            create: async (payload: { data: { file_name: string; file: ReadStream } }) => {
              uploads.push({ name: payload.data.file_name })
              // The fake consumes nothing; destroy the stream so no fd leaks.
              payload.data.file.destroy()
              return { file_key: 'fk_new' }
            },
          },
        },
      },
    }
    await createFileReplySender(client as never)('om_1', { name: 'report.md', path: deliverable })
    expect(uploads).toEqual([{ name: 'report.md' }])
    expect(replies).toEqual([{ messageId: 'om_1', msgType: 'file', content: JSON.stringify({ file_key: 'fk_new' }) }])
  })

  it('throws when the upload returns no key', async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-feishu-filereply-'))
    const deliverable = join(fixtureRoot, 'x.bin')
    await writeFile(deliverable, 'x')
    const client = {
      im: {
        v1: {
          message: { reply: async () => ({ code: 0 }) },
          file: {
            create: async (payload: { data: { file: ReadStream } }) => {
              payload.data.file.destroy()
              return null
            },
          },
        },
      },
    }
    await expect(
      createFileReplySender(client as never)('om_1', { name: 'x', path: deliverable }),
    ).rejects.toThrow(/no file_key/)
  })
})
