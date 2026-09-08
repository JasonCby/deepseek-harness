/** Package-owned invariant companion for the Feishu bot plugin. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-feishu'

/** Cordis invariant-companion plugin name. */
export const name = 'feishu-invariant'
/** Registry required before reserving this package's invariant ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: event authentication happens inside the Lark SDK at
 * the exact ingress operation, and dsh-host-webserver owns webhook
 * route/disposer symmetry.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's explained empty invariant.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the invariant registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
