/** Outbound replies: the one write path back to Feishu. */

import type { LarkApiClient } from './lark.ts'

/** Sends one text reply to the chat a message arrived in. */
export type ReplySender = (messageId: string, text: string) => Promise<void>

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
 * Bound one reply to the configured character ceiling.
 * @param text - the full reply text.
 * @param limit - the configured character ceiling.
 * @returns the text, or its truncated form with an ellipsis marker.
 */
export function truncateReply(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1)}…`
}
