/** Normalize the Lark SDK dispatcher payload into the transport-independent inbound form. */

import { stripMentionPlaceholders } from './prompt.ts'
import type { InboundAttachment, InboundMessage } from './types.ts'

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
 * Read the attachments one message type carries.
 * @param messageType - the event's `message_type`.
 * @param content - the parsed content document.
 * @returns the attachments, or undefined when the type is unsupported or its resource key is missing.
 */
function attachmentsOf(messageType: string | undefined, content: Record<string, unknown>): InboundAttachment[] | undefined {
  if (messageType === 'text') return []
  if (messageType === 'image') {
    const key = stringField(content, 'image_key')
    return key === undefined || key === '' ? undefined : [{ kind: 'image', key }]
  }
  if (messageType === 'file') {
    const key = stringField(content, 'file_key')
    if (key === undefined || key === '') return undefined
    const name = stringField(content, 'file_name')
    return [{ kind: 'file', key, ...name === undefined ? {} : { name } }]
  }
  return undefined
}

/**
 * Normalize one `im.message.receive_v1` dispatcher payload. The SDK flattens
 * header and event into one record for both transports, so this is the single
 * wire-boundary validation point. Unsupported shapes (unsupported message
 * types, missing identities, bot senders) return undefined rather than
 * throwing so a malformed or irrelevant event never breaks the 3-second
 * acknowledgement.
 * @param data - the SDK dispatcher payload.
 * @returns the normalized message, or undefined when the event is not one supported chat message.
 */
export function normalizeEventData(data: unknown): InboundMessage | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const root = data as Record<string, unknown>
  const sender = objectField(root, 'sender')
  if (sender !== undefined && stringField(sender, 'sender_type') === 'app') return undefined
  const message = objectField(root, 'message')
  if (message === undefined) return undefined
  const messageId = stringField(message, 'message_id')
  const chatId = stringField(message, 'chat_id')
  const contentRaw = stringField(message, 'content')
  if (messageId === undefined || messageId === '' || chatId === undefined || chatId === '' || contentRaw === undefined) {
    return undefined
  }
  let content: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(contentRaw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    content = parsed as Record<string, unknown>
  } catch {
    // Message content is defined by Feishu as a JSON document; anything else is not a chat message.
    return undefined
  }
  const messageType = stringField(message, 'message_type')
  const attachments = attachmentsOf(messageType, content)
  if (attachments === undefined) return undefined
  const text = messageType === 'text' ? stripMentionPlaceholders(stringField(content, 'text') ?? '') : ''
  const mentions: unknown = message['mentions']
  const senderId = sender === undefined ? undefined : objectField(sender, 'sender_id')
  const senderOpenId = senderId === undefined ? undefined : stringField(senderId, 'open_id')
  return {
    messageId,
    chatId,
    chatType: stringField(message, 'chat_type') ?? 'p2p',
    ...senderOpenId === undefined ? {} : { senderOpenId },
    text,
    attachments,
    mentioned: Array.isArray(mentions) && mentions.length > 0,
  }
}
