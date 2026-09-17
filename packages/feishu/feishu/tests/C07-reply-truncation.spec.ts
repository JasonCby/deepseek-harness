/** C07: reply truncation against the configured character ceiling. */

import { truncateReply } from '../src/reply.ts'
import { describe, expect, it } from 'vitest'

describe('truncateReply', () => {
  it('keeps short text and truncates long text', () => {
    expect(truncateReply('short', 10)).toBe('short')
    const truncated = truncateReply('a'.repeat(20), 10)
    expect(truncated.length).toBe(10)
    expect(truncated.endsWith('…')).toBe(true)
  })
})
