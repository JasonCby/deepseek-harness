/** Shared Feishu (Lark) chat-event types used by both transport edges. */

/** Chat channel the bot listens on, selected at edge start. */
export type FeishuTransport = 'websocket' | 'webhook'

/** One downloadable media attachment an inbound message carries. */
export interface InboundAttachment {
  /** Message-resource API type that downloads this attachment. */
  readonly kind: 'image' | 'file'
  /** Feishu resource key: `image_key` for images, `file_key` for files. */
  readonly key: string
  /** Sender-visible filename, when the event carries one. */
  readonly name?: string
}

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
  /** Media attachments the message carries, in arrival order. */
  readonly attachments: readonly InboundAttachment[]
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
