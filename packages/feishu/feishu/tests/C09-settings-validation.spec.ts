/** C09: settings and composition config validation — domains, paths, notices, allowlists, credential refs. */

import { assertConfig, assertSettings, credentialRefsOf, type FeishuSettings } from '../src/config.ts'
import { describe, expect, it } from 'vitest'

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
    replyCharLimit: 4000,
    failureNotice: 'failed',
    dedupCapacity: 1024,
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
})
