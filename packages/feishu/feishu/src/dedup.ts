/** Bounded insertion-ordered deduplication for Feishu message identities. */

/**
 * Remember recently seen message identities so transport retries (Feishu
 * re-pushes an event until it is acknowledged) are processed once. Insertion
 * order is the eviction order: retries always arrive after the first delivery,
 * so FIFO eviction never drops an identity a retry could still need before its
 * replacement.
 */
export class MessageDedup {
  private readonly seen = new Set<string>()

  /**
   * @param capacity - maximum remembered identities; the oldest is evicted beyond it.
   */
  constructor(private readonly capacity: number) {}

  /**
   * Record one identity.
   * @param id - Feishu message identity.
   * @returns true when the identity is new, false when it is a retry.
   */
  claim(id: string): boolean {
    if (this.seen.has(id)) return false
    this.seen.add(id)
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value
      // Set preserves insertion order, so the first value is the oldest entry.
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    return true
  }
}
