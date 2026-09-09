/**
 * The entitlement predicate, deliberately alone in a module with no imports.
 *
 * Split out from `entitlement.ts` (which pulls in Mongoose models via the `@/` alias)
 * so `scripts/test-entitlement.ts` can import it under plain `node
 * --experimental-strip-types`, which resolves neither the alias nor Mongoose.
 */

/** Stripe statuses that entitle a viewer. Everything else — `past_due`, `unpaid`, `incomplete`, `canceled`, `paused` — does not. */
const ENTITLING_STATUSES = new Set(['active', 'trialing'])

export type EntitlementState = {
  status: string
  /**
   * Optional as well as nullable: `.lean()` skips schema defaults, so a row written
   * before this field existed reads back as `undefined` despite the schema's `null`.
   */
  currentPeriodEnd?: Date | null
}

/**
 * Whether a stored subscription row entitles its owner right now.
 *
 * The `currentPeriodEnd` check is a fail-closed backstop: normally Stripe moves the
 * status to `past_due` and the webhook writes it here, but if that webhook never
 * arrives an expired period still denies access rather than granting it forever. The
 * cost is that a *renewal* whose webhook is lost also reads as expired, which is the
 * right way round to be wrong.
 */
export function isEntitled(sub: EntitlementState | null, now: Date = new Date()): boolean {
  if (!sub || !ENTITLING_STATUSES.has(sub.status)) return false
  // Absent before Stripe has billed the first period; the status alone carries it then.
  return !sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() > now.getTime()
}
