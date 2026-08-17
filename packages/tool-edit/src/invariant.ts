/**
 * Package-owned invariant companion for `@hy-sde-org/dsh-tool-edit`.
 * @module @hy-sde-org/dsh-tool-edit/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@hy-sde-org/dsh-tool-edit'

/** Cordis companion plugin name. */
export const name = 'tool-edit-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the tool adapter owns no independent durable state;
 * filesystem mutation relations stay with the provider and policy plugins.
 * Each mode maps reads/writes onto ctx.fs; per-session hashline snapshot and
 * noop-loop state is validated behaviorally by the replace/hashline specs.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
