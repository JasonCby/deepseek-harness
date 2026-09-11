/** Normalize the Lark SDK dispatcher payload into the transport-independent inbound form. */

import { stripMentionPlaceholders } from './prompt.ts'
import type { InboundMessage } from './types.ts'

/**
 * Read one field as a plain object.
 * @param record - containing record.
 * @param field - field name to read.
 * @returns the field value when it is a plain object, else undefined.
 */
function objectField(record: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const value: unknown = record[field]
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read one field as a string.
 * @param record - containing record.
 * @param field - field name to read.
 * @returns the field value when it is a string, else undefined.
 */
function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value: unknown = record[field]
  return typeof value === 'string' ? value : undefined
}

/**
 * Normalize one `im.message.receive_v1` dispatcher payload. The SDK flattens
 * header and event into one record for both transports, so this is the single
 * wire-boundary validation point. Unsupported shapes (non-text messages,
 * missing identities, bot senders) return undefined rather than throwing so a
 * malformed or irrelevant event never breaks the 3-second acknowledgement.
 * @param data - the SDK dispatcher payload.
 * @returns the normalized message, or undefined when the event is not one chat text message.
 */
export function normalizeEventData(data: unknown): InboundMessage | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const root = data as Record<string, unknown>
  const sender = objectField(root, 'sender')
  if (sender !== undefined && stringField(sender, 'sender_type') === 'app') return undefined
  const message = objectField(root, 'message')
  if (message === undefined) return undefined
  if (stringField(message, 'message_type') !== 'text') return undefined
  const messageId = stringField(message, 'message_id')
  const chatId = stringField(message, 'chat_id')
  const contentRaw = stringField(message, 'content')
  if (messageId === undefined || messageId === '' || chatId === undefined || chatId === '' || contentRaw === undefined) {
    return undefined
  }
  let text: string
  try {
    const parsed: unknown = JSON.parse(contentRaw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    text = stringField(parsed as Record<string, unknown>, 'text') ?? ''
  } catch {
    // Message content is defined by Feishu as a JSON document; anything else is not a text message.
    return undefined
  }
  const mentions: unknown = message['mentions']
  const senderId = sender === undefined ? undefined : objectField(sender, 'sender_id')
  const senderOpenId = senderId === undefined ? undefined : stringField(senderId, 'open_id')
  const threadId = stringField(message, 'thread_id')
  return {
    messageId,
    chatId,
    chatType: stringField(message, 'chat_type') ?? 'p2p',
    ...threadId === undefined ? {} : { threadId },
    ...senderOpenId === undefined ? {} : { senderOpenId },
    text: stripMentionPlaceholders(text),
    mentioned: Array.isArray(mentions) && mentions.length > 0,
  }
}
