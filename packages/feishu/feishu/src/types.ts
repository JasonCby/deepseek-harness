/** Shared Feishu (Lark) chat-event types used by both transport edges. */

/** Chat channel the bot listens on, selected at edge start. */
export type FeishuTransport = 'websocket' | 'webhook'

/**
 * One inbound chat message normalized from the Lark SDK dispatcher payload.
 * Both transports deliver the same flattened event shape, so the core consumes
 * only this form.
 */
export interface InboundMessage {
  /** Feishu message identity; the dedup key. */
  readonly messageId: string
  /** Chat the message arrived in; the conversation routing key. */
  readonly chatId: string
  /** `p2p` for direct chats, `group` for group chats. */
  readonly chatType: string
  /** Sender `open_id`, when the event carries one. */
  readonly senderOpenId?: string
  /** Plain text with mention placeholders stripped. */
  readonly text: string
  /** Whether the event's mention list is non-empty (the bot, in a group). */
  readonly mentioned: boolean
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Chat message admitted from the Feishu bot plugin. */
    feishu: {
      readonly kind: 'feishu'
      /** Feishu chat the message arrived in. */
      readonly chatId: string
      /** Feishu message identity the prompt answers. */
      readonly messageId: string
      readonly form: 'notice'
      readonly summary: string
    }
  }
}
