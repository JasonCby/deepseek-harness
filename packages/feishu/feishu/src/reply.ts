/** Outbound replies: the one write path back to Feishu. */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { FeishuCard } from './card.ts'
import type { LarkApiClient } from './lark.ts'

/** One outbound reply payload: settled text as plain text or as a markdown card. */
export type ReplyContent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'card'; readonly card: FeishuCard }

/** Sends one reply to the chat a message arrived in. */
export type ReplySender = (messageId: string, content: ReplyContent) => Promise<void>

/**
 * Encode one reply payload as the wire form the reply API accepts.
 * @param content - the payload to encode.
 * @returns the `msg_type` plus serialized `content` the API call carries.
 */
function wirePayload(content: ReplyContent): { msg_type: 'text' | 'interactive'; content: string } {
  switch (content.kind) {
    case 'text':
      return { msg_type: 'text', content: JSON.stringify({ text: content.text }) }
    case 'card':
      return { msg_type: 'interactive', content: JSON.stringify(content.card) }
    default:
      return assertNever(content)
  }
}

/**
 * Create the reply sender over one API client.
 * @param client - the Lark API client carrying the app credentials.
 * @returns a sender that replies to the triggering message.
 * @throws when Feishu rejects the reply (non-zero response code).
 */
export function createReplySender(client: LarkApiClient): ReplySender {
  return async (messageId, content) => {
    const response = await client.im.v1.message.reply({
      path: { message_id: messageId },
      data: wirePayload(content),
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
