/** Chat-to-Session routing: one multi-turn Agent session per Feishu chat. */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import { boundContextSummary, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { feishuDeliverTool } from './deliver.ts'
import { frameChatPrompt } from './prompt.ts'
import type { FileReplySender, ReplySender } from './reply.ts'
import type { ResourceFetcher } from './resource.ts'
import { extractDeliverables, extractReplyText } from './settlement.ts'
import { truncateReply } from './reply.ts'
import type { FeishuSettings, Config } from './config.ts'
import type { InboundMessage } from './types.ts'
import { MessageDedup } from './dedup.ts'

/** Per-turn deliverable ceiling: a safety invariant against runaway declarations, not a deployment choice. */
const MAX_DELIVERABLES_PER_TURN = 20

/**
 * Derive the deterministic session identity of one chat. A stable mapping
 * survives restarts with no side-car storage: the first message after a
 * restart resumes the persisted session under the same id.
 * @param chatId - Feishu chat identity.
 * @returns the branded session id for the chat.
 */
export function sessionIdForChat(chatId: string): SessionId {
  const digest = createHash('sha256').update(chatId).digest('hex').slice(0, 32)
  return brandString<SessionId>(`feishu-${digest}`)
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

/**
 * One conversation per chat: deduplicates transport retries, serializes
 * message processing per chat (session creation must complete before the next
 * message is admitted), and settles each turn by replying with the assistant
 * text the session log recorded.
 */
export class ConversationRouter {
  private readonly handles = new Map<string, AgentHandle>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly dedup: MessageDedup
  private workspace: Promise<Workspace> | undefined
  private reply: ReplySender
  private replyFile: FileReplySender
  private fetchResource: ResourceFetcher

  /**
   * @param ctx - plugin context owning every chat agent.
   * @param options - composition-fixed conversation inputs.
   * @param settings - thunk returning the currently authoritative settings section.
   * @param placeholderReply - sender used before the first transport edge activates.
   * @param placeholderFileReply - file sender used before the first transport edge activates.
   * @param placeholderFetch - resource fetcher used before the first transport edge activates.
   */
  constructor(
    private readonly ctx: Context,
    private readonly options: ConversationOptions,
    private readonly settings: () => FeishuSettings,
    placeholderReply: ReplySender,
    placeholderFileReply: FileReplySender,
    placeholderFetch: ResourceFetcher,
  ) {
    this.dedup = new MessageDedup(settings().dedupCapacity)
    this.reply = placeholderReply
    this.replyFile = placeholderFileReply
    this.fetchResource = placeholderFetch
  }

  /**
   * Admission point both transports call synchronously. Deduplication and
   * queueing are immediate; processing settles asynchronously so the caller
   * can acknowledge Feishu within its retry window.
   * @param message - the normalized inbound chat message.
   */
  accept(message: InboundMessage): void {
    if (!this.dedup.claim(message.messageId)) return
    const tail = this.queues.get(message.chatId) ?? Promise.resolve()
    const next = tail.then(() => this.process(message)).finally(() => {
      if (this.queues.get(message.chatId) === next) this.queues.delete(message.chatId)
    })
    this.queues.set(message.chatId, next)
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
   * Point attachment downloads at the active transport edge's fetcher, which
   * carries the credentials that admitted the message.
   * @param fetcher - the active edge's resource fetcher.
   */
  setResourceFetcher(fetcher: ResourceFetcher): void {
    this.fetchResource = fetcher
  }

  /**
   * Point file replies at the active transport edge's file sender.
   * @param sender - the active edge's file reply sender.
   */
  setFileReplySender(sender: FileReplySender): void {
    this.replyFile = sender
  }

  /** Whether one chat message passes the live allowlist and mention gates. */
  private admitted(message: InboundMessage, settings: FeishuSettings): boolean {
    if (settings.allowChatIds.length > 0 && !settings.allowChatIds.includes(message.chatId)) return false
    if (settings.groupRequireMention && message.chatType === 'group' && !message.mentioned) return false
    return true
  }

  /** Process one admitted message end-to-end; never rejects. */
  private async process(message: InboundMessage): Promise<void> {
    const settings = this.settings()
    if (!this.admitted(message, settings)) return
    if (message.text === '' && message.attachments.length === 0) return
    try {
      const handle = await this.ensureAgent(message.chatId)
      const fromSeq = handle.agent.session.seq
      const attachments = await this.saveAttachments(message)
      const content: ContentBlock[] = [
        ...attachments.map((ref): ContentBlock => ({ type: 'file', attachment: ref })),
        { type: 'text', text: frameChatPrompt(message) },
      ]
      handle.agent.followup(createUserMessage({
        content,
        source: {
          kind: 'feishu',
          chatId: message.chatId,
          messageId: message.messageId,
          form: 'notice',
          summary: boundContextSummary(`Feishu chat message ${message.messageId}`),
        },
      }))
      await handle.agent.whenIdle()
      const replyText = extractReplyText(handle.agent.session.snapshotEvents(), fromSeq)
      await this.reply(
        message.messageId,
        replyText === undefined
          ? settings.failureNotice
          : truncateReply(replyText, settings.replyCharLimit),
      )
      await this.deliverDeclared(message.messageId, handle, fromSeq)
    } catch (error: unknown) {
      console.error(`feishu DEBUG processing failed: ${error instanceof Error ? String(error.stack ?? error.message) : String(error)}`)
      this.ctx.logger.warn(`feishu: processing message ${message.messageId} failed: ${error instanceof Error ? error.message : String(error)}`)
      try {
        await this.reply(message.messageId, settings.failureNotice)
      } catch (noticeError: unknown) {
        // The failure notice shares the credentials and client of the failed
        // turn; a second refusal carries no additional signal.
        this.ctx.logger.warn(`feishu: failure notice for ${message.messageId} was not delivered: ${noticeError instanceof Error ? noticeError.message : String(noticeError)}`)
      }
    }
  }

  /**
   * Download one message's attachments into the attachment store. Files reach
   * the model as file blocks; the runtime projects each to a read-only host
   * path, so no provider has to accept media natively.
   * @param message - the message whose attachments are saved.
   * @returns the durable refs, in arrival order.
   */
  private async saveAttachments(message: InboundMessage): Promise<FileAttachmentRef[]> {
    const saved: FileAttachmentRef[] = []
    for (const attachment of message.attachments) {
      const data = await this.fetchResource(message.messageId, attachment)
      saved.push(await this.ctx.attachments.saveFileStream({
        data,
        name: attachment.name ?? attachment.key,
      }))
    }
    return saved
  }

  /**
   * Upload the files the settled turn declared through the deliver tool, each
   * as its own file message. One delivery failing never fails the turn — the
   * text reply already reached the chat; the failure is logged and the
   * remaining files still go out.
   * @param messageId - the triggering message the files reply to.
   * @param handle - the chat's settled agent.
   * @param fromSeq - the log position the turn began at.
   */
  private async deliverDeclared(messageId: string, handle: AgentHandle, fromSeq: number): Promise<void> {
    const deliverables = extractDeliverables(handle.agent.session.snapshotEvents(), fromSeq)
    for (const path of deliverables.slice(0, MAX_DELIVERABLES_PER_TURN)) {
      try {
        await this.replyFile(messageId, { name: basename(path), path })
      } catch (error: unknown) {
        this.ctx.logger.warn(`feishu: delivering ${path} for ${messageId} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Resolve the live agent of one chat, creating or resuming it once. */
  private async ensureAgent(chatId: string): Promise<AgentHandle> {
    const cached = this.handles.get(chatId)
    if (cached !== undefined && this.ctx.agents.get(cached.agent.session.id) !== undefined) return cached
    this.handles.delete(chatId)
    const sessionId = sessionIdForChat(chatId)
    // Another surface (the Web UI viewing this chat's session) may already
    // hold the session's write claim with a live agent; borrowing it beats
    // failing the turn, since a second resume would collide on that claim.
    const live = this.ctx.agents.get(sessionId)
    console.error(`feishu DEBUG ensureAgent: live=${String(live !== undefined)} sessionId=${sessionId}`)
    if (live !== undefined) {
      // A borrowed agent's setup ran elsewhere, so its deliver tool mounts here.
      await live.ctx.plugin(feishuDeliverTool)
      const borrowed: AgentHandle = { agent: live, dispose: async () => {} }
      this.handles.set(chatId, borrowed)
      return borrowed
    }
    const persisted = (await this.ctx.sessionPersistence.list())
      .some(snapshot => snapshot.header.id === sessionId)
    const handle = persisted
      ? await this.resumeAgent(sessionId)
      : await this.createAgent(sessionId, chatId)
    this.handles.set(chatId, handle)
    return handle
  }

  /** Mount the chat composition and the deliver tool on one unpublished agent scope. */
  private async mount(agentCtx: Context, presetId: string): Promise<void> {
    await this.ctx.agentPresets.mount(agentCtx, presetId)
    await agentCtx.plugin(feishuDeliverTool)
  }

  /** Create the chat's first agent session. */
  private async createAgent(sessionId: SessionId, chatId: string): Promise<AgentHandle> {
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
      this.ctx.sessionTitle.rename(handle.agent.session, `Feishu chat ${chatId}`)
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
