/** Outbound Feishu interactive cards: a pure markdown projection of one settled reply. */

/** One Feishu interactive card as the reply path serializes it (card JSON 1.0). */
export interface FeishuCard {
  /** Card header; `template` is the Feishu spec's fixed blue banner. */
  readonly header: { template: 'blue'; title: { tag: 'plain_text'; content: string } }
  /** One markdown element carries the whole settled reply. */
  readonly elements: [{ tag: 'markdown'; content: string }]
}

/**
 * Project one settled reply's markdown into a single-element interactive card.
 * @param markdown - the settled reply text, already truncated to the configured limit.
 * @param title - the configured card header title.
 * @returns the card to send as an `interactive` message.
 */
export function renderMarkdownCard(markdown: string, title: string): FeishuCard {
  return {
    header: { template: 'blue', title: { tag: 'plain_text', content: title } },
    elements: [{ tag: 'markdown', content: markdown }],
  }
}
