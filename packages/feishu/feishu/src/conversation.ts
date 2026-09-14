/** Chat-to-Session routing: one multi-turn Agent session per Feishu chat. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { renderMarkdownCard } from './card.ts'
import { frameChatPrompt } from './prompt.ts'
import { matchCardTemplate, renderTemplateReply, resolveTemplateVariables } from './template.ts'
import type { ReplyContent, ReplySender } from './reply.ts'
import type { ReactionSender } from './reaction.ts'
import type { OpenedTopic, TopicOpener } from './topic.ts'
import { topicSummary } from './topic.ts'
import { extractReplyText, resolveReplyForm } from './settlement.ts'
import { truncateReply } from './reply.ts'
import type { FeishuSettings, Config } from './config.ts'
import type { InboundMessage, ResolvedReplyForm } from './types.ts'
import { MessageDedup } from './dedup.ts'

/**
 * Derive the deterministic session identity of one conversation. A stable
 * mapping survives restarts with no side-car storage: the first message after
 * a restart resumes the persisted session under the same id.
 * @param chatId - Feishu chat identity.
 * @param threadId - topic thread identity, or undefined for the chat's main stream.
 * @returns the branded session id for the conversation.
 */
function sessionKeyFor(chatId: string, threadId: string | undefined): SessionId {
  // The composite separator cannot occur inside a chat id, so topic material
  // never collides with any plain chat's derivation input.
  const material = threadId === undefined ? chatId : `${chatId}\n${threadId}`
  const digest = createHash('sha256').update(material).digest('hex').slice(0, 32)
  return brandString<SessionId>(`feishu-${digest}`)
}

/**
 * Derive the deterministic session identity of one chat's main stream.
 * @param chatId - Feishu chat identity.
 * @returns the branded session id for the chat.
 */
export function sessionIdForChat(chatId: string): SessionId {
  return sessionKeyFor(chatId, undefined)
}

/**
 * Derive the deterministic session identity of one topic thread.
 * @param chatId - Feishu chat the topic belongs to.
 * @param threadId - topic thread identity (`omt_`-prefixed).
 * @returns the branded session id for the topic.
 */
export function sessionIdForThread(chatId: string, threadId: string): SessionId {
  return sessionKeyFor(chatId, threadId)
}

/** Conversation inputs fixed by the composition; settings fields stay live. */
export interface ConversationOptions {
  /** Existing local directory every chat session works in. */
  readonly workspacePath: string
  /** Agent composition mounted for each chat session. */
  readonly agentPreset: string
  /** Sandbox and approval preset applied to each chat session. */
  readonly permissionPreset: string
}

/** Between edges no API client exists; an absent indicator must not fail a turn. */
const silentReactions: ReactionSender = {
  add: () => Promise.resolve(undefined),
  remove: () => Promise.resolve(),
}

/** Between edges no topic can open; the failure degrades the turn to an in-place reply. */
const unreachableTopics: TopicOpener = {
  open: () => Promise.reject(new Error('feishu: no transport edge is active')),
}

/**
 * One conversation per chat main stream or topic thread: deduplicates
 * transport retries, serializes message processing per conversation (session
 * creation must complete before the next message is admitted), and settles
 * each turn by replying with the assistant text the session log recorded.
 */
export class ConversationRouter {
  /** Live agents per conversation; an adopted agent carries no dispose capability. */
  private readonly handles = new Map<SessionId, { readonly agent: Agent }>()
  private readonly queues = new Map<SessionId, Promise<void>>()
  private readonly dedup: MessageDedup
  private workspace: Promise<Workspace> | undefined
  private reply: ReplySender
  private reactions: ReactionSender = silentReactions
  private topics: TopicOpener = unreachableTopics

  /**
   * @param ctx - plugin context owning every chat agent.
   * @param options - composition-fixed conversation inputs.
   * @param settings - thunk returning the currently authoritative settings section.
   * @param placeholderReply - sender used before the first transport edge activates.
   */
  constructor(
    private readonly ctx: Context,
    private readonly options: ConversationOptions,
    private readonly settings: () => FeishuSettings,
    placeholderReply: ReplySender,
  ) {
    this.dedup = new MessageDedup(settings().dedupCapacity)
    this.reply = placeholderReply
  }

  /**
   * Admission point both transports call synchronously. Deduplication and
   * queueing are immediate; processing settles asynchronously so the caller
   * can acknowledge Feishu within its retry window.
   * @param message - the normalized inbound chat message.
   */
  accept(message: InboundMessage): void {
    if (!this.dedup.claim(message.messageId)) return
    const key = sessionKeyFor(message.chatId, message.threadId)
    const tail = this.queues.get(key) ?? Promise.resolve()
    const next = tail.then(() => this.process(message)).finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key)
    })
    this.queues.set(key, next)
  }

  /**
   * Point replies at the active transport edge's sender. The controller calls
   * this on every edge activation; between edges the placeholder answers with
   * a delivery failure.
   * @param sender - the active edge's reply sender.
   */
  setReplySender(sender: ReplySender): void {
    this.reply = sender
  }

  /**
   * Point the thinking indicator at the active transport edge's sender. The
   * controller calls this beside {@link ConversationRouter.setReplySender};
   * between edges the silent placeholder applies.
   * @param sender - the active edge's reaction sender.
   */
  setReactionSender(sender: ReactionSender): void {
    this.reactions = sender
  }

  /**
   * Point topic opening at the active transport edge's opener. The controller
   * calls this beside {@link ConversationRouter.setReplySender}; between edges
   * the unreachable placeholder degrades turns to in-place replies.
   * @param opener - the active edge's topic opener.
   */
  setTopicOpener(opener: TopicOpener): void {
    this.topics = opener
  }

  /** Whether one chat message passes the live allowlist and mention gates. */
  private admitted(message: InboundMessage, settings: FeishuSettings): boolean {
    if (settings.allowChatIds.length > 0 && !settings.allowChatIds.includes(message.chatId)) return false
    if (settings.groupRequireMention && message.chatType === 'group' && !message.mentioned) return false
    return true
  }

  /**
   * Resolve one settled payload's reply content under its concrete form.
   * @param text - the settled reply text or failure notice, already truncated.
   * @param form - the concrete reply form the turn resolved to.
   * @param settings - the currently authoritative settings section.
   * @returns the payload the active transport delivers.
   */
  private payload(text: string, form: ResolvedReplyForm, settings: FeishuSettings): ReplyContent {
    return form === 'card'
      ? { kind: 'card', card: renderMarkdownCard(text, settings.cardTitle) }
      : { kind: 'text', text }
  }

  /** Form one failure notice takes: only an explicit `card` setting sends notices as cards. */
  private failureForm(settings: FeishuSettings): ResolvedReplyForm {
    return settings.replyForm === 'card' ? 'card' : 'text'
  }

  /**
   * Resolve the card form's payload: the first matching bound template with
   * resolvable variables, else the markdown projection.
   * @param settled - the settled reply text the projection fallback carries.
   * @param message - the routed message the turn answers.
   * @param events - the session's ordered event log.
   * @param fromSeq - the log position just before the triggering prompt was admitted.
   * @param settings - the currently authoritative settings section.
   * @returns the card payload the turn delivers.
   */
  private cardPayload(
    settled: string,
    message: InboundMessage,
    events: readonly SessionEvent[],
    fromSeq: number,
    settings: FeishuSettings,
  ): ReplyContent {
    const entry = matchCardTemplate(settings.cardTemplates, events, fromSeq)
    if (entry !== undefined) {
      const resolved = resolveTemplateVariables(entry, events, fromSeq, message)
      if ('variables' in resolved) return renderTemplateReply(entry, resolved.variables, settings.cardLocale)
      this.ctx.logger.warn(`feishu: template "${entry.name}" falls back to the markdown card: ${resolved.error}`)
    }
    return { kind: 'card', card: renderMarkdownCard(settled, settings.cardTitle) }
  }

  /**
   * Deliver one reply; a refused template payload retries once as the markdown
   * projection so a misconfigured template never loses the answer.
   * @param replyTo - the message the reply targets.
   * @param content - the resolved reply payload.
   * @param settled - the settled reply text the fallback projection carries.
   * @param settings - the currently authoritative settings section.
   * @throws when the reply (or its fallback) is refused.
   */
  private async deliver(replyTo: string, content: ReplyContent, settled: string, settings: FeishuSettings): Promise<void> {
    try {
      await this.reply(replyTo, content)
    } catch (error: unknown) {
      if (content.kind !== 'template' && content.kind !== 'localCard') throw error
      this.ctx.logger.warn(`feishu: template delivery failed, retrying as the markdown card: ${error instanceof Error ? error.message : String(error)}`)
      await this.reply(replyTo, { kind: 'card', card: renderMarkdownCard(settled, settings.cardTitle) })
    }
  }

  /**
   * Add the configured thinking emoji to one admitted message, best-effort.
   * @param messageId - the admitted message the indicator attaches to.
   * @param settings - the currently authoritative settings section.
   * @returns the reaction identity, or undefined when the indicator is off or failed.
   */
  private async markThinking(messageId: string, settings: FeishuSettings): Promise<string | undefined> {
    if (settings.thinkingEmoji === '') return undefined
    try {
      return await this.reactions.add(messageId, settings.thinkingEmoji)
    } catch (error: unknown) {
      this.ctx.logger.warn(`feishu: thinking reaction for ${messageId} was not added: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** Remove the thinking reaction one turn added, best-effort. */
  private async clearThinking(messageId: string, reactionId: string | undefined): Promise<void> {
    if (reactionId === undefined) return
    try {
      await this.reactions.remove(messageId, reactionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`feishu: thinking reaction for ${messageId} was not removed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Open one topic for a main-stream message under the `replyInThread`
   * setting; a refusal degrades the turn to an in-place reply.
   * @param message - the admitted message.
   * @param settings - the currently authoritative settings section.
   * @returns the opened topic, or undefined when the turn stays in place.
   */
  private async beginTopic(message: InboundMessage, settings: FeishuSettings): Promise<OpenedTopic | undefined> {
    if (!settings.replyInThread || message.threadId !== undefined) return undefined
    try {
      return await this.topics.open(message.messageId, topicSummary(message.text))
    } catch (error: unknown) {
      this.ctx.logger.warn(`feishu: opening a topic for ${message.messageId} failed; replying in place: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** Process one admitted message end-to-end; never rejects. */
  private async process(message: InboundMessage): Promise<void> {
    const settings = this.settings()
    if (!this.admitted(message, settings)) return
    if (message.text === '') return
    const reactionId = await this.markThinking(message.messageId, settings)
    const topic = await this.beginTopic(message, settings)
    const routed: InboundMessage = topic === undefined ? message : { ...message, threadId: topic.threadId }
    const replyTo = topic?.leadMessageId ?? message.messageId
    try {
      const handle = await this.ensureAgent(routed)
      const fromSeq = handle.agent.session.seq
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: frameChatPrompt(routed) }],
        source: {
          kind: 'feishu',
          chatId: message.chatId,
          messageId: message.messageId,
          form: 'notice',
          summary: boundContextSummary(`Feishu chat message ${message.messageId}`),
        },
      }))
      await handle.agent.whenIdle()
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const events = handle.agent.session.snapshotEvents()
      const replyText = extractReplyText(events, fromSeq)
      const failed = replyText === undefined
      const settled = failed ? settings.failureNotice : truncateReply(replyText, settings.replyCharLimit)
      const form = failed
        ? this.failureForm(settings)
        : resolveReplyForm(settings.replyForm, events, fromSeq)
      const content: ReplyContent = form === 'card'
        ? this.cardPayload(settled, routed, events, fromSeq, settings)
        : { kind: 'text', text: settled }
      await this.deliver(replyTo, content, settled, settings)
    } catch (error: unknown) {
      this.ctx.logger.warn(`feishu: processing message ${message.messageId} failed: ${error instanceof Error ? error.message : String(error)}`)
      try {
        await this.reply(replyTo, this.payload(settings.failureNotice, this.failureForm(settings), settings))
      } catch (noticeError: unknown) {
        // The failure notice shares the credentials and client of the failed
        // turn; a second refusal carries no additional signal.
        this.ctx.logger.warn(`feishu: failure notice for ${message.messageId} was not delivered: ${noticeError instanceof Error ? noticeError.message : String(noticeError)}`)
      }
    } finally {
      await this.clearThinking(message.messageId, reactionId)
    }
  }

  /**
   * Resolve the live agent of one conversation, creating or resuming it once.
   * A live agent another channel published for the conversation's session (the
   * Web UI opened it) owns the identity — resuming the same id would collide —
   * so it is adopted as-is; its owning channel keeps teardown.
   * @param message - the admitted message naming the conversation.
   * @returns the live agent view the turn runs on.
   */
  private async ensureAgent(message: InboundMessage): Promise<{ readonly agent: Agent }> {
    const sessionId = sessionKeyFor(message.chatId, message.threadId)
    const cached = this.handles.get(sessionId)
    if (cached !== undefined && this.ctx.agents.get(cached.agent.session.id) !== undefined) return cached
    this.handles.delete(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      const adopted = { agent: live }
      this.handles.set(sessionId, adopted)
      return adopted
    }
    const persisted = (await this.ctx.sessionPersistence.list())
      .some(snapshot => snapshot.header.id === sessionId)
    const handle = persisted
      ? await this.resumeAgent(sessionId)
      : await this.createAgent(sessionId, message)
    this.handles.set(sessionId, handle)
    return handle
  }

  /** Mount the chat composition on one unpublished agent scope. */
  private async mount(agentCtx: Context, presetId: string): Promise<void> {
    await this.ctx.agentPresets.mount(agentCtx, presetId)
  }

  /** Create the conversation's first agent session. */
  private async createAgent(sessionId: SessionId, message: InboundMessage): Promise<AgentHandle> {
    const selection = this.ctx.agentDefaultModel.currentSelection()
    this.ctx.permissionPresets.resolve(this.options.permissionPreset)
    const preset = await this.ctx.agentPresets.resolve(this.options.agentPreset)
    await this.ctx.agentPresets.standingKeyFor(preset.id)
    const workspace = await this.ensureWorkspace()
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path, agentPreset: preset.id },
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      },
      setup: async (agentCtx) => {
        await this.mount(agentCtx, preset.id)
      },
    })
    let attached = false
    try {
      await workspace.attachSession(sessionId)
      attached = true
      this.ctx.permissionPresets.set(handle.agent.session, this.options.permissionPreset)
      this.ctx.sessionTitle.rename(handle.agent.session, message.threadId === undefined
        ? `Feishu chat ${message.chatId}`
        : `Feishu chat ${message.chatId} topic ${message.threadId}`)
      return handle
    } catch (error: unknown) {
      if (attached) {
        try {
          await workspace.detachSession(sessionId)
        } catch (rollbackError: unknown) {
          this.ctx.logger.warn(`feishu: workspace detach for ${sessionId} failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        }
      }
      try {
        await handle.dispose()
      } catch (rollbackError: unknown) {
        this.ctx.logger.warn(`feishu: agent disposal for ${sessionId} failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
      }
      throw error
    }
  }

  /** Resume the chat's persisted agent session after a restart. */
  private async resumeAgent(sessionId: SessionId): Promise<AgentHandle> {
    const presetId = this.options.agentPreset
    const selection = this.ctx.agentDefaultModel.currentSelection()
    return this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      },
      setup: async (agentCtx, agent) => {
        // The session header's durable preset composed this session's tools;
        // mount exactly it so replayed history stays actionable.
        const logged = agent.session.header.agentPreset
        await this.mount(agentCtx, logged ?? presetId)
      },
    })
  }

  /** Resolve the shared chat workspace once. */
  private ensureWorkspace(): Promise<Workspace> {
    this.workspace ??= this.ctx.workspaceRegistry.create(this.options.workspacePath)
    return this.workspace
  }
}

/** Narrowed composition view the router constructor consumes. */
export type ConversationConfig = Config
