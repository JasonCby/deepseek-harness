/** C09: settings and composition config validation — domains, paths, notices, allowlists, credential refs, card templates. */

import { assertConfig, assertSettings, credentialRefsOf, type FeishuSettings } from '../src/config.ts'
import type { CardTemplateEntry } from '../src/template.ts'
import { describe, expect, it } from 'vitest'

/** The builder's multilingual export, reduced from a tenant sample. */
const builderExport = {
  config: { update_multi: true },
  i18n_elements: {
    zh_cn: [
      { tag: 'img', img_key: 'img_v3_02gm', scale_type: 'crop_center' },
      {
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: '8px',
        margin: '16px 0px 0px 0px',
        columns: [{ tag: 'column', width: 'weighted', weight: 1, background_style: 'grey', elements: [{ tag: 'markdown', content: '**订单金额**' }] }],
      },
    ],
  },
  i18n_header: {
    zh_cn: { title: { tag: 'plain_text', content: '恭喜{{who}}签约' }, template: 'red' },
  },
}

/** One minimal valid settings section. */
function base(): FeishuSettings {
  return {
    transport: 'websocket',
    domain: 'feishu',
    appIdEnv: 'DSH_FEISHU_APP_ID',
    appSecretEnv: 'DSH_FEISHU_APP_SECRET',
    verificationTokenEnv: 'DSH_FEISHU_VERIFICATION_TOKEN',
    encryptKeyEnv: 'DSH_FEISHU_ENCRYPT_KEY',
    path: '/feishu',
    maxBodyBytes: 65536,
    allowChatIds: [],
    groupRequireMention: true,
    replyInThread: false,
    replyCharLimit: 4000,
    replyForm: 'text',
    cardTitle: 'DSH',
    cardLocale: 'zh_cn',
    thinkingEmoji: 'Typing',
    failureNotice: 'failed',
    dedupCapacity: 1024,
    cardTemplates: [],
    interactionCards: {
      enabled: false,
      approval: { approveLabel: 'Approve', rejectLabel: 'Reject' },
      question: { title: 'Please answer', submitLabel: 'Submit' },
    },
  }
}

describe('settings validation', () => {
  it('accepts the base section', () => {
    expect(() => {
      assertSettings(base())
    }).not.toThrow()
  })

  it('accepts domain shorthands and self-hosted origins, rejecting the rest', () => {
    expect(() => { assertSettings({ ...base(), domain: 'lark' }) }).not.toThrow()
    expect(() => { assertSettings({ ...base(), domain: 'https://open.internal.example.com' }) }).not.toThrow()
    expect(() => { assertSettings({ ...base(), domain: 'internal' }) }).toThrow(/domain/)
    expect(() => { assertSettings({ ...base(), domain: 'https://open.internal.example.com/' }) }).toThrow(/domain/)
    expect(() => { assertSettings({ ...base(), domain: ' https://open.internal.example.com' }) }).toThrow(/domain/)
  })

  it('rejects malformed paths, empty notices, and dirty allowlists', () => {
    expect(() => {
      assertSettings({ ...base(), path: 'feishu' })
    }).toThrow(/path/)
    expect(() => {
      assertSettings({ ...base(), path: '/' })
    }).toThrow(/path/)
    expect(() => {
      assertSettings({ ...base(), failureNotice: ' ' })
    }).toThrow(/failureNotice/)
    expect(() => {
      assertSettings({ ...base(), allowChatIds: [' x'] })
    }).toThrow(/allowChatIds/)
    expect(() => {
      assertSettings({ ...base(), cardTitle: ' ' })
    }).toThrow(/cardTitle/)
    expect(() => {
      assertSettings({ ...base(), thinkingEmoji: ' Typing' })
    }).toThrow(/thinkingEmoji/)
  })

  it('lists every credential reference the section consumes', () => {
    const refs = credentialRefsOf({ ...base(), appSecretEnv: 'FEISHU_SECRET' })
    expect(refs).toEqual([
      'DSH_FEISHU_APP_ID',
      'FEISHU_SECRET',
      'DSH_FEISHU_VERIFICATION_TOKEN',
      'DSH_FEISHU_ENCRYPT_KEY',
    ])
  })

  it('rejects an empty workspace path in the composition config', () => {
    expect(() => {
      assertConfig({ ...base(), workspacePath: ' ', agentPreset: 'standard', permissionPreset: 'read-only' })
    }).toThrow(/workspacePath/)
  })

  it('rejects malformed card template entries', () => {
    const entry: CardTemplateEntry = {
      name: 'alarm',
      bindTool: 'workflow',
      templateId: 'AAq1',
      variables: { who: { from: 'context', key: 'senderOpenId' } },
    }
    const withTemplates = (cardTemplates: CardTemplateEntry[]): FeishuSettings => ({ ...base(), cardTemplates })
    expect(() => { assertSettings(withTemplates([entry, { ...entry }])) }).toThrow(/names/)
    expect(() => { assertSettings(withTemplates([{ ...entry, card: { elements: [{ tag: 'hr' }] } }])) }).toThrow(/exactly one/)
    const { templateId: _platform, ...neither } = entry
    const local = { ...neither, card: { elements: [{ tag: 'markdown', content: '{{who}}' }] } }
    expect(() => { assertSettings(withTemplates([neither])) }).toThrow(/exactly one/)
    expect(() => { assertSettings(withTemplates([{ ...neither, card: { elements: [] } }])) }).toThrow(/elements array/)
    expect(() => { assertSettings(withTemplates([{ ...local, variables: { a: { from: 'context', key: 'nope' } } }])) }).toThrow(/context key/)
    expect(() => { assertSettings(withTemplates([{ ...local, variables: { a: { from: 'tool-result' } } }])) }).toThrow(/tool-result path/)
    expect(() => { assertSettings(withTemplates([local])) }).not.toThrow()
    expect(() => { assertSettings(withTemplates([{ ...local, card: { schema: '2.0', body: { elements: [{ tag: 'hr' }] } } }])) }).toThrow(/card JSON 2\.0/)
    expect(() => { assertSettings(withTemplates([{ ...neither, card: { i18n_elements: { en_us: [{ tag: 'hr' }] } } }])) }).toThrow(/"zh_cn" elements array/)
    expect(() => { assertSettings(withTemplates([{ ...neither, card: builderExport }])) }).not.toThrow()
    expect(() => { assertSettings({ ...base(), cardLocale: ' ' }) }).toThrow(/cardLocale/)
  })
})
