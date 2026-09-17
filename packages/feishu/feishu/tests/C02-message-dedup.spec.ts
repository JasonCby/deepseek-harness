/** C02: transport retry deduplication — one claim per message identity, bounded capacity. */

import { MessageDedup } from '../src/dedup.ts'
import { describe, expect, it } from 'vitest'

describe('MessageDedup', () => {
  it('claims each identity once', () => {
    const dedup = new MessageDedup(4)
    expect(dedup.claim('a')).toBe(true)
    expect(dedup.claim('a')).toBe(false)
    expect(dedup.claim('b')).toBe(true)
  })

  it('evicts the oldest identity beyond capacity', () => {
    const dedup = new MessageDedup(2)
    dedup.claim('a')
    dedup.claim('b')
    dedup.claim('c')
    expect(dedup.claim('a')).toBe(true)
    expect(dedup.claim('c')).toBe(false)
  })
})
