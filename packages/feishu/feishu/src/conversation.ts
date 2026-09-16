/** Chat-to-Session routing: one multi-turn Agent session per Feishu chat. */

import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import { boundContextSummary, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { feishuDeliverTool } from './deliver.ts'
import { frameChatPrompt } from './prompt.ts'
import type { CardReplySender, FileReplySender, ReplySender } from './reply.ts'
import type { ResourceFetcher } from './resource.ts'
import { extractCards, extractDeliverables, extractReplyText } from './settlement.ts'
import { truncateReply } from './reply.ts'
import type { FeishuSettings, Config } from './config.ts'
import type { InboundMessage } from './types.ts'
import { MessageDedup } from './dedup.ts'

/** Per-turn deliverable ceiling: a safety invariant against runaway declarations, not a deployment choice. */
const MAX_DELIVERABLES_PER_TURN = 20

/** Messages whose trimmed text equals one of these start a fresh session for the chat. */
const RESET_COMMANDS = new Set(['/new', '/reset', '/新会话'])

/** Command listing the chat's session generations. */
const LIST_COMMAND = '/sessions'

/** Command moving the chat's routing pointer, with its generation argument. */
const SWITCH_PATTERN = /^\/switch(?:\s+(\S+))?$/

/** Reply sent when a reset command lands, naming the generation just opened. */
function resetNotice(epoch: number): string {
  return `已开启新会话（#${String(epoch)}）。输入 /sessions 可查看历史会话，/switch <序号> 可切回。`
}

/** Cap on listed generations so a long-lived chat never floods the reply. */
const MAX_LISTED_GENERATIONS = 20

/** Short display form of one generation's session id. */
function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 'feishu-'.length + 8)
}

/** Format one generation's creation time for the session list. */
function formatGenerationTime(createdAt: number): string {
  return new Date(createdAt).toLocaleString('zh-CN', { hour12: false })
}

/** One chat's generation state: where messages route now, and the ceiling ever opened. */
interface ChatGenerations {
  /** Generation the chat currently routes to. */
  current: number
  /** Highest generation ever opened; /new advances it so session ids never collide. */
  max: number
}

/** Interpret one persisted per-chat value, accepting the legacy bare-epoch format. */
function parseGenerations(value: unknown): ChatGenerations | undefined {
  if (Number.isSafeInteger(value) && (value as number) > 0) {
    return { current: value as number, max: value as number }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const { current, max } = value as Record<string, unknown>
    if (Number.isSafeInteger(current) && Number.isSafeInteger(max)
      && (current as number) >= 0 && (max as number) >= (current as number)) {
      return { current: current as number, max: max as number }
    }
  }
  return undefined
}

/**
 * Derive the deterministic session identity of one chat generation. A stable
 * mapping survives restarts with no side-car storage: the first message after a
 * restart resumes the persisted session under the same id. A `/new` command
 * bumps the epoch, so the next generation hashes to a different, fresh id while
 * prior sessions stay on disk for review.
 * @param chatId - Feishu chat identity.
 * @param epoch - chat generation, incremented by reset commands.
 * @returns the branded session id for the chat generation.
 */
export function sessionIdForChat(chatId: string, epoch = 0): SessionId {
  const digest = createHash('sha256').update(`${chatId}#${String(epoch)}`).digest('hex').slice(0, 32)
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
  /** Per-chat routing pointer and generation ceiling; a reset bumps max so ids never collide. */
  private readonly generations = new Map<string, ChatGenerations>()
  /** Whether the persisted generation file has been loaded into memory. */
  private generationsLoaded = false
  private readonly dedup: MessageDedup
  private workspace: Promise<Workspace> | undefined
  private reply: ReplySender
  private replyFile: FileReplySender
  private replyCard: CardReplySender
  private fetchResource: ResourceFetcher

  /**
   * @param ctx - plugin context owning every chat agent.
   * @param options - composition-fixed conversation inputs.
   * @param settings - thunk returning the currently authoritative settings section.
   * @param placeholderReply - sender used before the first transport edge activates.
   * @param placeholderFileReply - file sender used before the first transport edge activates.
   * @param placeholderFetch - resource fetcher used before the first transport edge activates.
   * @param placeholderCardReply - card sender used before the first transport edge activates.
   */
  constructor(
    private readonly ctx: Context,
    private readonly options: ConversationOptions,
    private readonly settings: () => FeishuSettings,
    placeholderReply: ReplySender,
    placeholderFileReply: FileReplySender,
    placeholderFetch: ResourceFetcher,
    placeholderCardReply: CardReplySender,
  ) {
    this.dedup = new MessageDedup(settings().dedupCapacity)
    this.reply = placeholderReply
    this.replyFile = placeholderFileReply
    this.fetchResource = placeholderFetch
    this.replyCard = placeholderCardReply
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

  /**
   * Point card replies at the active transport edge's card sender.
   * @param sender - the active edge's card reply sender.
   */
  setCardReplySender(sender: CardReplySender): void {
    this.replyCard = sender
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
    // Commands never reach the agent: they adjust local routing state and
    // answer directly, leaving no trace in the session log.
    const command = message.text.trim()
    if (RESET_COMMANDS.has(command)) {
      const epoch = await this.resetChat(message.chatId)
      await this.replyCommand(message.messageId, resetNotice(epoch))
      return
    }
    if (command === LIST_COMMAND) {
      await this.replyCommand(message.messageId, await this.sessionListText(message.chatId))
      return
    }
    const switchTarget = SWITCH_PATTERN.exec(command)
    if (switchTarget !== null) {
      await this.replyCommand(message.messageId, await this.switchChat(message.chatId, switchTarget[1]))
      return
    }
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
      const events = handle.agent.session.snapshotEvents()
      const replyText = extractReplyText(events, fromSeq)
      await this.reply(
        message.messageId,
        replyText === undefined
          ? settings.failureNotice
          : truncateReply(replyText, settings.replyCharLimit),
      )
      await this.deliverDeclared(message.messageId, events, fromSeq)
    } catch (error: unknown) {
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
   * Absolute path of the small JSON file that persists chat generations across
   * restarts. Without it, a restart would roll every chat back to generation 0
   * and resume the oldest persisted session instead of the one the user last used.
   * @returns the state file path under DSH_HOME (or ~/.dsh).
   */
  private epochsPath(): string {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    return join(home, 'feishu-router-state.json')
  }

  /** Load persisted chat generations once; a missing or corrupt file starts fresh. */
  private async loadGenerations(): Promise<void> {
    if (this.generationsLoaded) return
    this.generationsLoaded = true
    try {
      const raw = await readFile(this.epochsPath(), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [chatId, value] of Object.entries(parsed as Record<string, unknown>)) {
          const state = parseGenerations(value)
          if (state !== undefined) this.generations.set(chatId, state)
        }
      }
    } catch {
      // No state file yet (first run) or it was unreadable: start at generation 0.
    }
  }

  /** Persist the chat generations atomically so a crash never loses the latest reset. */
  private async saveGenerations(): Promise<void> {
    const path = this.epochsPath()
    const tmp = join(dirname(path), `.feishu-router-state.${randomUUID()}.tmp`)
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.generations), null, 2), 'utf8')
    await rename(tmp, path)
  }

  /** Reply to one command; a failed notice is logged, never thrown. */
  private async replyCommand(messageId: string, text: string): Promise<void> {
    try {
      await this.reply(messageId, text)
    } catch (error: unknown) {
      this.ctx.logger.warn(`feishu: command reply for ${messageId} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Render the chat's persisted session generations newest-first. Generation
   * ids are pure functions of chat and epoch, so listing needs no side-car
   * storage: only generations with a persisted snapshot are shown.
   * @param chatId - chat whose generations are listed.
   * @returns the reply text.
   */
  private async sessionListText(chatId: string): Promise<string> {
    await this.loadGenerations()
    const state = this.generations.get(chatId) ?? { current: 0, max: 0 }
    const snapshots = await this.ctx.sessionPersistence.list()
    const persisted = new Map(snapshots.map(snapshot => [snapshot.header.id as string, snapshot.header]))
    const lines: string[] = []
    for (let epoch = state.max; epoch >= Math.max(0, state.max - MAX_LISTED_GENERATIONS + 1); epoch--) {
      const sessionId = sessionIdForChat(chatId, epoch)
      const header = persisted.get(sessionId)
      const current = epoch === state.current
      // Every generation is listed so the count matches the rows: ones that
      // never carried a message (a /new left behind unused) are marked 未使用.
      const stamp = typeof header?.createdAt === 'number' ? `  ${formatGenerationTime(header.createdAt)}` : ''
      const suffix = current
        ? (header === undefined ? '（当前，新会话尚未开始）' : '（当前）')
        : (header === undefined ? '（未使用）' : '')
      lines.push(`${current ? '▶' : ' '} #${String(epoch)}  ${shortSessionId(sessionId)}${stamp}${suffix}`)
    }
    const total = state.max + 1
    const heading = total > MAX_LISTED_GENERATIONS
      ? `本会话群共有 ${String(total)} 个会话世代（显示最近 ${String(MAX_LISTED_GENERATIONS)} 个）：`
      : `本会话群共有 ${String(total)} 个会话世代：`
    return [heading, ...lines, '发送 /switch <序号> 切换。'].join('\n')
  }

  /**
   * Move the chat's routing pointer to one earlier generation. The live handle
   * is only unbound, never disposed; the next message resumes (or borrows) the
   * target session through the ordinary ensureAgent path.
   * @param chatId - chat whose pointer moves.
   * @param argument - the raw generation argument from the command.
   * @returns the reply text.
   */
  private async switchChat(chatId: string, argument: string | undefined): Promise<string> {
    await this.loadGenerations()
    // No entry means the chat never left the implicit generation 0.
    const state = this.generations.get(chatId) ?? { current: 0, max: 0 }
    // Tolerate angle brackets copied from the usage text (`/switch <1>`).
    const raw = argument?.replace(/^<(\S+)>$/, '$1')
    const target = raw === undefined || raw === '' ? Number.NaN : Number(raw)
    if (!Number.isSafeInteger(target) || target < 0 || target > state.max) {
      return `用法：/switch <序号>（0 到 ${String(state.max)}）。可先用 /sessions 查看列表。`
    }
    if (target === state.current) return `当前已在会话 #${String(target)}。`
    this.handles.delete(chatId)
    state.current = target
    try {
      await this.saveGenerations()
    } catch (error: unknown) {
      this.ctx.logger.warn(`feishu: persisting router state failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return `已切换到会话 #${String(target)}。下一条消息将进入该会话。`
  }

  /**
   * Unbind one chat's live agent from its chat channel and open the next
   * generation. The old agent stays alive in the agent registry and its
   * persisted session stays on disk, so it keeps showing up in the Web UI and
   * remains switchable; only the chat's routing pointer moves on.
   * @param chatId - chat whose conversation is being reset.
   * @returns the generation just opened.
   */
  private async resetChat(chatId: string): Promise<number> {
    await this.loadGenerations()
    this.handles.delete(chatId)
    const state = this.generations.get(chatId) ?? { current: 0, max: 0 }
    // New generations always extend the ceiling: after a /switch back to an
    // old generation, current+1 would collide with an existing session id.
    state.max += 1
    state.current = state.max
    this.generations.set(chatId, state)
    try {
      await this.saveGenerations()
    } catch (error: unknown) {
      this.ctx.logger.warn(`feishu: persisting router state failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return state.current
  }

  /**
   * Send the cards and files the settled turn declared through the deliver
   * tool, each as its own reply message. One delivery failing never fails the
   * turn — the text reply already reached the chat; the failure is logged and
   * the remaining items still go out.
   * @param messageId - the triggering message the items reply to.
   * @param events - the chat session's ordered event log.
   * @param fromSeq - the log position the turn began at.
   */
  private async deliverDeclared(messageId: string, events: readonly SessionEvent[], fromSeq: number): Promise<void> {
    const cards = extractCards(events, fromSeq)
    for (const card of cards.slice(0, MAX_DELIVERABLES_PER_TURN)) {
      try {
        await this.replyCard(messageId, card)
      } catch (error: unknown) {
        this.ctx.logger.warn(`feishu: delivering a card for ${messageId} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const deliverables = extractDeliverables(events, fromSeq)
    for (const path of deliverables.slice(0, MAX_DELIVERABLES_PER_TURN)) {
      try {
        await this.replyFile(messageId, { name: basename(path), path })
      } catch (error: unknown) {
        this.ctx.logger.warn(`feishu: delivering ${path} for ${messageId} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Resolve the live agent of one chat generation, creating or resuming it once. */
  private async ensureAgent(chatId: string): Promise<AgentHandle> {
    const cached = this.handles.get(chatId)
    if (cached !== undefined && this.ctx.agents.get(cached.agent.session.id) !== undefined) return cached
    this.handles.delete(chatId)
    await this.loadGenerations()
    const epoch = this.generations.get(chatId)?.current ?? 0
    const sessionId = sessionIdForChat(chatId, epoch)
    // Another surface (the Web UI viewing this chat's session) may already
    // hold the session's write claim with a live agent; borrowing it beats
    // failing the turn, since a second resume would collide on that claim.
    const live = this.ctx.agents.get(sessionId)
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
      : await this.createAgent(sessionId, chatId, epoch)
    this.handles.set(chatId, handle)
    return handle
  }

  /** Mount the chat composition and the deliver tool on one unpublished agent scope. */
  private async mount(agentCtx: Context, presetId: string): Promise<void> {
    await this.ctx.agentPresets.mount(agentCtx, presetId)
    await agentCtx.plugin(feishuDeliverTool)
  }

  /** Create the chat's first agent session. */
  private async createAgent(sessionId: SessionId, chatId: string, epoch: number): Promise<AgentHandle> {
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
      this.ctx.sessionTitle.rename(handle.agent.session, `Feishu chat ${chatId} #${String(epoch)}`)
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
