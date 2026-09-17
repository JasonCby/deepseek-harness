/** Topic threads the bot opens on admitted main-stream messages. */

import type { LarkApiClient } from './lark.ts'
import { truncateReply } from './reply.ts'

/** Fixed summary bound: the lead message is an index line, not content. */
const TOPIC_SUMMARY_CHAR_LIMIT = 64

/** One opened topic: the bot's lead message and the topic's identity. */
export interface OpenedTopic {
  /** The bot's summary message inside the topic; answers reply to it to stay in the topic. */
  readonly leadMessageId: string
  /** The topic identity; the conversation routes to its own session. */
  readonly threadId: string
}

/** Opens one topic per main-stream message under the `replyInThread` setting. */
export interface TopicOpener {
  /**
   * Open one topic rooted at the given message.
   * @param messageId - the main-stream message the topic roots at.
   * @param summary - the one-line lead content shown inside the topic.
   * @returns the lead message identity and the topic identity.
   * @throws when Feishu rejects the call or the response carries no thread identity.
   */
  open(messageId: string, summary: string): Promise<OpenedTopic>
}

/**
 * Create the topic opener over one API client.
 * @param client - the Lark API client carrying the app credentials.
 * @returns an opener whose calls throw on Feishu refusals and missing identities.
 */
export function createTopicOpener(client: LarkApiClient): TopicOpener {
  return {
    open: async (messageId, summary) => {
      const response = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text: summary }), reply_in_thread: true },
      })
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`feishu topic open failed with code ${String(response.code)}: ${response.msg ?? 'no message'}`)
      }
      const leadMessageId = response.data?.message_id
      const threadId = response.data?.thread_id
      if (leadMessageId === undefined || leadMessageId === '' || threadId === undefined || threadId === '') {
        throw new Error('feishu topic open succeeded without a thread identity')
      }
      return { leadMessageId, threadId }
    },
  }
}

/**
 * Project one message's text into the one-line topic summary.
 * @param text - the sender-written message text.
 * @returns the single-lined text, truncated to the fixed summary bound.
 */
export function topicSummary(text: string): string {
  return truncateReply(text.replace(/\s+/g, ' ').trim(), TOPIC_SUMMARY_CHAR_LIMIT)
}
