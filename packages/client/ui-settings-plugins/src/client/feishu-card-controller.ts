/**
 * The Feishu bot card's staged form over the `feishu` settings namespace.
 *
 * The app secret never rides a response, so the card learns only whether one
 * is configured and writes it through the credentials domain, addressed by the
 * reference the section names. The transport and allowlist are ordinary
 * section fields with local conversions: enum text for the two transports and
 * domains, comma-separated text for the chat allowlist.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  CardForm, type CardActions, type CardFieldSpec, type CardFieldState, type CardShell,
} from './card-form.ts'

/**
 * Namespace of the Feishu bot plugin. Spelled here rather than imported: a
 * client package must not depend on a Host package.
 */
export const FEISHU_NS = 'feishu'

/** Credential reference the plugin resolves when the section names none. */
const DEFAULT_APP_SECRET_REF = 'DSH_FEISHU_APP_SECRET'

/** Form field the credential control stages under. */
const APP_SECRET_FIELD = 'appSecret'

/** The transports the plugin's settings accept. */
const TRANSPORTS = ['websocket', 'webhook'] as const
/** Domain shorthands the plugin's settings accept besides a self-hosted origin. */
const DOMAIN_SHORTHANDS = ['feishu', 'lark'] as const

/** The feishu fields this card edits. */
export interface FeishuSettings {
  /** Ingress transport: outbound long connection or inbound webhook route. */
  transport?: string
  /** Open-platform domain. */
  domain?: string
  /** Literal app id; blank inherits the referenced credential. */
  appId?: string
  /** Credential reference the app secret is read from; blank uses the plugin default. */
  appSecretEnv?: string
  /** Chats the bot answers; empty answers every chat that reaches it. */
  allowChatIds?: string[]
}

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  /** Reference this answer describes; a stale response for another one is dropped. */
  ref: string
  /** Whether any layer supplies a value for it. */
  configured: boolean
  /** Whether `credentials/set` can affect it; false disables the control. */
  writable: boolean
}

/** What the Feishu card renders. */
export interface FeishuCardState extends CardShell {
  /** Ingress transport. */
  transport: CardFieldState
  /** Open-platform domain. */
  domain: CardFieldState
  /** Literal app id. */
  appId: CardFieldState
  /** Chat allowlist as comma-separated text. */
  allowChatIds: CardFieldState
  /** The staged app secret, which starts blank on every load. */
  appSecret: CardFieldState
  /** Whether the Host reports a credential configured for the referenced secret. */
  appSecretConfigured: boolean
  /** Whether the credentials domain accepts a write for it; false disables the control. */
  appSecretWritable: boolean
}

/** The registration-side face the Feishu card's slot entry injects. */
export interface FeishuCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useFeishuCard. */
    feishuCard: SnapshotStore<FeishuCardState>
  }
}

/** Bridges the `feishu` scope and the credentials domain onto the card. */
export class FeishuCardController {
  private readonly form: CardForm<FeishuSettings>
  private readonly store: SnapshotStore<FeishuCardState>
  private credential: CredentialState = { ref: '', configured: false, writable: true }

  /**
   * @param scope - the bound settings scope for the `feishu` namespace.
   * @param ctx - the card plugin's context, whose `remote.credentials` namespace
   * answers for the credential the section references.
   */
  constructor(
    private readonly scope: SettingsScope<FeishuSettings>,
    private readonly ctx: ClientContext,
  ) {
    this.form = new CardForm(
      scope,
      [
        enumField('transport', TRANSPORTS),
        domainField(),
        textLiteralField('appId'),
        listField('allowChatIds'),
      ],
      [{ field: APP_SECRET_FIELD, write: text => this.writeAppSecret(text) }],
    )
    this.store = this.form.bind(() => this.projection())
    scope.subscribe(() => { void this.readCredential() })
    void this.readCredential()
  }

  private projection(): FeishuCardState {
    return {
      ...this.form.shell(),
      transport: this.form.field('transport'),
      domain: this.form.field('domain'),
      appId: this.form.field('appId'),
      allowChatIds: this.form.field('allowChatIds'),
      appSecret: this.form.field(APP_SECRET_FIELD),
      appSecretConfigured: this.credential.configured,
      appSecretWritable: this.credential.writable,
    }
  }

  /**
   * Ask the credentials domain about the reference the section currently names.
   * The answer is stored with the reference it describes so two reads that
   * settle out of order cannot publish a stale reference's state.
   */
  private async readCredential(): Promise<void> {
    const ref = refOf(this.scope.getSnapshot())
    if (ref !== this.credential.ref) {
      this.credential = { ref, configured: false, writable: true }
      this.store.set(this.projection())
    }
    const response = await this.ctx.remote.credentials.describe([ref])
    if (!response.ok || ref !== refOf(this.scope.getSnapshot())) return
    const view = response.value[ref]
    const next: CredentialState = {
      ref,
      configured: view?.configured ?? false,
      writable: view?.writable ?? true,
    }
    if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
    this.credential = next
    this.store.set(this.projection())
  }

  /**
   * Re-read after the Host reports a change to the reference this card watches.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    if (ref !== this.credential.ref) return
    void this.readCredential()
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): FeishuCardFace {
    return { hooks: { feishuCard: this.store }, ...this.form.actions() }
  }

  /**
   * Write the staged secret, then re-read whether the Host now holds one.
   * @param value - the staged credential literal.
   * @returns whether the Host reports a configured credential afterwards.
   */
  private async writeAppSecret(value: string): Promise<boolean> {
    await this.ctx.remote.credentials.set(refOf(this.scope.getSnapshot()), value)
    await this.readCredential()
    return this.credential.configured
  }
}

/** One-of-several text field: only the listed values parse, so a bad draft blocks the save. */
function enumField(field: string, values: readonly string[]): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      return values.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
    },
  }
}

/** Domain field: a shorthand or a self-hosted deployment's absolute http(s) origin. */
function domainField(): CardFieldSpec {
  return {
    field: 'domain',
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const shorthand = (DOMAIN_SHORTHANDS as readonly string[]).includes(trimmed)
      const origin = /^https?:\/\/.+/.test(trimmed) && !trimmed.endsWith('/')
      return shorthand || origin ? { kind: 'set', value: trimmed } : undefined
    },
  }
}

/** A free-text literal: an empty draft clears the field back to the referenced credential. */
function textLiteralField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/** A comma-separated list: blank clears the allowlist; every other draft writes the split items. */
function listField(field: string): CardFieldSpec {
  return {
    field,
    format: value => Array.isArray(value) ? value.join(', ') : '',
    parse: (text) => {
      const items = text.split(',').map(item => item.trim()).filter(item => item !== '')
      return items.length === 0 ? { kind: 'clear' } : { kind: 'set', value: items }
    },
  }
}

/**
 * The credential reference the section names, or the plugin's default.
 * @param snapshot - the current scope snapshot.
 * @returns the reference to address.
 */
function refOf(snapshot: SettingsScopeSnapshot<FeishuSettings>): string {
  const declared = snapshot.value?.appSecretEnv
  return declared !== undefined && declared.length > 0 ? declared : DEFAULT_APP_SECRET_REF
}
