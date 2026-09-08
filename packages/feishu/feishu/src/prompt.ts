/** Prompt framing for untrusted Feishu chat input. */

import type { InboundMessage } from './types.ts'

/** Feishu inserts `@_user_<n>` placeholders where the sender mentioned someone. */
const MENTION_PLACEHOLDER = /@_user_\d+/g

/**
 * Strip mention placeholders from message text.
 * @param text - raw text content of one chat message.
 * @returns the text a sender would read, trimmed; empty when the message was only mentions.
 */
export function stripMentionPlaceholders(text: string): string {
  return text.replaceAll(MENTION_PLACEHOLDER, '').trim()
}

/**
 * Frame one chat message as the prompt text of one agent turn. The prefix keeps
 * provenance and trust level visible to the model; the message text itself is
 * untrusted external input and never quoted back into instructions.
 * @param message - the normalized inbound message.
 * @returns the model-facing prompt text.
 */
export function frameChatPrompt(message: InboundMessage): string {
  const sender = message.senderOpenId ?? 'unknown'
  return `Feishu chat message (untrusted external input; chat ${message.chatId}, sender ${sender}):\n\n${message.text}`
}
