/** Thinking-indicator reactions: one emoji brackets each admitted turn. */

import type { LarkApiClient } from './lark.ts'

/** Best-effort reaction lifecycle over one API client. */
export interface ReactionSender {
  /**
   * Add one emoji reaction to a message.
   * @param messageId - the admitted message the indicator attaches to.
   * @param emoji - the configured emoji key.
   * @returns the reaction identity, or undefined when the response carried none.
   * @throws when Feishu rejects the call (non-zero response code).
   */
  add(messageId: string, emoji: string): Promise<string | undefined>
  /**
   * Remove one reaction {@link ReactionSender.add} returned.
   * @param messageId - the message carrying the reaction.
   * @param reactionId - the identity the add call returned.
   * @throws when Feishu rejects the call (non-zero response code).
   */
  remove(messageId: string, reactionId: string): Promise<void>
}

/**
 * Create the reaction sender over one API client.
 * @param client - the Lark API client carrying the app credentials.
 * @returns a sender whose calls throw on Feishu refusals.
 */
export function createReactionSender(client: LarkApiClient): ReactionSender {
  return {
    add: async (messageId, emoji) => {
      const response = await client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      })
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`feishu reaction add failed with code ${String(response.code)}: ${response.msg ?? 'no message'}`)
      }
      return response.data?.reaction_id
    },
    remove: async (messageId, reactionId) => {
      const response = await client.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`feishu reaction remove failed with code ${String(response.code)}: ${response.msg ?? 'no message'}`)
      }
    },
  }
}
