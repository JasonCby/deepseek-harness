/**
 * The deliverable-declaration tool the bot's chat sessions mount. The model
 * calls it with the finished files a turn should hand back to Feishu; paths
 * are validated immediately and delivered from the session log at settlement.
 * @module feishu-deliver
 */

import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Feishu refuses messaging uploads over 30 MB and refuses empty files. */
const MAX_FILE_BYTES = 30 * 1024 * 1024

/** A card payload must be a plain object carrying Feishu's elements array. */
function isCardPayload(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Array.isArray((value as Record<string, unknown>).elements)
}

/** The tool name the settlement scan matches. */
export const DELIVER_TOOL_NAME = 'feishu_deliver'

/** Cordis plugin name. */
export const name = 'feishu-deliver-tool'

/** Core services required before the tool can register. */
export const inject = ['tools']

/**
 * Register the deliver tool on one (agent-scoped) context. Mounted by the
 * conversation router inside every chat session's setup, and onto a borrowed
 * live agent, so every surface driving the session sees the same tool.
 * @param ctx - the owning agent-scoped context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: DELIVER_TOOL_NAME,
    description:
      'Queue finished files and/or interactive message cards for delivery to the Feishu chat this turn answers. '
      + 'Call it once per turn with the final deliverables only — never intermediate artifacts. '
      + 'Each path is validated now (must exist, be a non-empty file under 30 MB) '
      + 'and uploaded to the chat after the turn settles. Each card is a Feishu card JSON object '
      + '(must contain an "elements" array; optional "header" and "config") and is sent as an interactive message.',
    parameters: {
      paths: {
        type: 'array',
        description: 'Absolute paths of the finished files to deliver.',
        items: { type: 'string' },
      },
      cards: {
        type: 'array',
        description: 'Feishu interactive card JSON objects to send, in order. Each object needs an "elements" array.',
        items: { type: 'object', additionalProperties: true },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                name: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
              },
            },
          },
          rejected: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          acceptedCards: {
            type: 'integer',
            required: true,
          },
          rejectedCards: {
            type: 'integer',
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Delivery queue: ${String(value.accepted.length)} files accepted `
          + `(${value.accepted.map(file => file.name).join(', ') || 'none'}), `
          + `${String(value.rejected.length)} files rejected; `
          + `${String(value.acceptedCards)} cards accepted, ${String(value.rejectedCards)} cards rejected.`,
      }],
    },
    async execute(args) {
      const accepted: { path: string; name: string; bytes: number }[] = []
      const rejected: { path: string; reason: string }[] = []
      const paths = Array.isArray(args.paths) ? (args.paths as unknown[]) : []
      const cards = Array.isArray(args.cards) ? (args.cards as unknown[]) : []
      for (const path of paths) {
        if (typeof path !== 'string') continue
        try {
          const info = await stat(path)
          if (!info.isFile()) {
            rejected.push({ path, reason: 'not a regular file' })
            continue
          }
          if (info.size === 0) {
            rejected.push({ path, reason: 'empty file' })
            continue
          }
          if (info.size > MAX_FILE_BYTES) {
            rejected.push({ path, reason: 'over the 30 MB upload limit' })
            continue
          }
          accepted.push({ path, name: basename(path), bytes: info.size })
        } catch (error: unknown) {
          rejected.push({ path, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      let acceptedCards = 0
      let rejectedCards = 0
      for (const card of cards) {
        if (isCardPayload(card)) {
          acceptedCards += 1
        } else {
          rejectedCards += 1
        }
      }
      return { accepted, rejected, acceptedCards, rejectedCards }
    },
    presentCall: args => ({ card: 'generic', title: 'Deliver files to Feishu', kind: 'other', rawInput: args.paths }),
  }))
}

/** The plugin object the conversation router mounts on chat session contexts. */
export const feishuDeliverTool = { name, inject, apply }
