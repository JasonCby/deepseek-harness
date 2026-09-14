/** Inbound media: the one download path from a Feishu message to its bytes. */

import type { LarkApiClient } from './lark.ts'
import type { InboundAttachment } from './types.ts'

/** Fetches one inbound attachment's bytes through the active edge's credentials. */
export type ResourceFetcher = (
  messageId: string,
  attachment: InboundAttachment,
) => Promise<AsyncIterable<Uint8Array>>

/**
 * Create the resource fetcher over one API client.
 * @param client - the Lark API client carrying the app credentials.
 * @returns a fetcher that streams one attachment's bytes.
 * @throws when the download request fails (the resource API throws on HTTP errors).
 */
export function createResourceFetcher(client: LarkApiClient): ResourceFetcher {
  return async (messageId, attachment) => {
    const download = await client.im.v1.messageResource.get({
      params: { type: attachment.kind },
      path: { message_id: messageId, file_key: attachment.key },
    })
    return download.getReadableStream()
  }
}
