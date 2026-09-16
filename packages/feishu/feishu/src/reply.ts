/** Outbound replies: the write paths back to Feishu. */

import { createReadStream } from 'node:fs'
import type { LarkApiClient } from './lark.ts'

/** Sends one text reply to the chat a message arrived in. */
export type ReplySender = (messageId: string, text: string) => Promise<void>

/** Sends one file reply to the chat a message arrived in. */
export type FileReplySender = (messageId: string, file: { name: string; path: string }) => Promise<void>

/** Sends one interactive card reply to the chat a message arrived in. */
export type CardReplySender = (messageId: string, card: Record<string, unknown>) => Promise<void>

/**
 * Create the reply sender over one API client.
 * @param client - the Lark API client carrying the app credentials.
 * @returns a sender that replies to the triggering message.
 * @throws when Feishu rejects the reply (non-zero response code).
 */
export function createReplySender(client: LarkApiClient): ReplySender {
  return async (messageId, text) => {
    const response = await client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text }) },
    })
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`feishu reply failed with code ${String(response.code)}: ${response.msg ?? 'no message'}`)
    }
  }
}

/**
 * Create the interactive-card reply sender over one API client.
 * @param client - the Lark API client carrying the app credentials.
 * @returns a sender that replies with one Feishu message card (`msg_type: interactive`).
 * @throws when Feishu rejects the card (non-zero response code).
 */
export function createCardReplySender(client: LarkApiClient): CardReplySender {
  return async (messageId, card) => {
    const response = await client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'interactive', content: JSON.stringify(card) },
    })
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`feishu card reply failed with code ${String(response.code)}: ${response.msg ?? 'no message'}`)
    }
  }
}

/**
 * Create the file reply sender over one API client: upload the file, then
 * reply with the returned key so the chat receives a downloadable file message.
 * @param client - the Lark API client carrying the app credentials.
 * @returns a sender that delivers one local file to the triggering message's chat.
 * @throws when the upload returns no key or Feishu rejects the reply.
 */
export function createFileReplySender(client: LarkApiClient): FileReplySender {
  return async (messageId, file) => {
    const uploaded = await client.im.v1.file.create({
      data: { file_type: 'stream', file_name: file.name, file: createReadStream(file.path) },
    })
    const fileKey = uploaded?.file_key
    if (fileKey === undefined || fileKey === '') {
      throw new Error(`feishu file upload for ${file.name} returned no file_key`)
    }
    const response = await client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
    })
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`feishu file reply failed with code ${String(response.code)}: ${response.msg ?? 'no message'}`)
    }
  }
}

/**
 * Bound one reply to the configured character ceiling.
 * @param text - the full reply text.
 * @param limit - the configured character ceiling.
 * @returns the text, or its truncated form with an ellipsis marker.
 */
export function truncateReply(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1)}…`
}
