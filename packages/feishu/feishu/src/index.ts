/**
 * Feishu (Lark) bot plugin: receive chat events over a long connection or a
 * webhook route, run each chat as one multi-turn DSH session, and reply with
 * the assistant text each completed turn leaves in the session log.
 * @module @deepseek-ai/dsh-feishu
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  Config,
  FEISHU_SETTINGS_NAMESPACE,
  SettingsConfig,
  assertConfig,
  assertSettings,
  settingsEntryOf,
} from './config.ts'
import type { FeishuSettings } from './config.ts'
import { ConversationRouter } from './conversation.ts'
import { EdgeController } from './edges.ts'
import type { WebServerRouteRegistrar } from './edges.ts'
import { larkSdk } from './lark.ts'

export type { InboundMessage, FeishuTransport, ReplyForm, ResolvedReplyForm } from './types.ts'
export {
  Config,
  SettingsConfig,
  FEISHU_SETTINGS_NAMESPACE,
  assertConfig,
  assertSettings,
  settingsEntryOf,
} from './config.ts'
export { ConversationRouter, sessionIdForChat, sessionIdForThread } from './conversation.ts'
export {
  EdgeController,
  resolveAppCredentials,
  startWebhookEdge,
  startWebsocketEdge,
} from './edges.ts'
export type { TransportEdge, AppCredentials, WebServerRouteRegistrar } from './edges.ts'
export { normalizeEventData } from './ingress.ts'
export { larkSdk } from './lark.ts'
export type { LarkSdk, LarkApiClient, LarkMessageReactionResource, LarkDispatcher, LarkWsClient, LarkResponse } from './lark.ts'
export { frameChatPrompt, stripMentionPlaceholders } from './prompt.ts'
export { renderMarkdownCard } from './card.ts'
export type { FeishuCard } from './card.ts'
export { createReplySender, truncateReply } from './reply.ts'
export type { ReplySender, ReplyContent } from './reply.ts'
export { createReactionSender } from './reaction.ts'
export type { ReactionSender } from './reaction.ts'
export { createTopicOpener, topicSummary } from './topic.ts'
export type { TopicOpener, OpenedTopic } from './topic.ts'
export { extractReplyText, resolveReplyForm } from './settlement.ts'
export { MessageDedup } from './dedup.ts'

/** Cordis function-plugin name. */
export const name = 'feishu'

/** Core services required before any chat event can be served. */
export const inject = [
  'agents',
  'agentPresets',
  'agentDefaultModel',
  'permissionPresets',
  'workspaceRegistry',
  'sessionTitle',
  'sessionPersistence',
  'credentials',
]

/**
 * Register the Feishu bot: the conversation router, the settings section, and
 * the initial transport edge.
 * @param ctx - plugin context owning chat agents and transport edges.
 * @param config - validated composition configuration.
 */
export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  let source: () => FeishuSettings = () => settingsEntryOf(config)
  const router = new ConversationRouter(
    ctx,
    { workspacePath: config.workspacePath, agentPreset: config.agentPreset, permissionPreset: config.permissionPreset },
    () => source(),
    () => Promise.reject(new Error('feishu: no transport edge is active')),
  )
  // Loader entries live in isolated realms, so the optional WebServer is only
  // visible through an explicit inject; the ref tracks its presence live and
  // arrival/disappearance re-runs an edge blocked on it.
  let webServer: WebServerRouteRegistrar | undefined
  const controller = new EdgeController(ctx, larkSdk, router, () => source(), () => webServer)
  ctx.effect(() => () => {
    controller.dispose()
  }, 'feishu: transport edges')
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      webServer = webCtx.get('webServer')
      if (source().transport === 'webhook') controller.reconfigure()
      return () => {
        webServer = undefined
      }
    })
  })

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, FEISHU_SETTINGS_NAMESPACE, SettingsConfig, settingsEntryOf(config), {
      setSource: (next) => {
        source = next
      },
      onChange: () => {
        controller.reconfigure()
      },
      validate: (value) => {
        assertSettings(value)
        if (value.transport === 'webhook' && webServer === undefined) {
          throw new Error('feishu: webhook transport requires a webServer service in the composition')
        }
      },
    })
  })
  // Without a settings service the composition entry stays authoritative; the
  // first installSection attach (now or later) starts the edge through onChange.
  if (ctx.get('settings') === undefined) controller.reconfigure()
}
