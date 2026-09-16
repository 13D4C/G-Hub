/**
 * The entitlement predicate, deliberately alone in a module with no imports.
 *
 * Split out from `entitlement.ts` (which pulls in Mongoose models via the `@/` alias)
 * so `scripts/test-entitlement.ts` can import it under plain `node
 * --experimental-strip-types`, which resolves neither the alias nor Mongoose.
 */

/**
 * Stripe statuses that entitle a viewer. Everything else — `past_due`, `unpaid`,
 * `incomplete`, `canceled`, `paused` — does not.
 *
 * Exported so a query that wants to *narrow* on status can use the same list rather
 * than restating it and drifting from the predicate. `isEntitled` remains the
 * decision: a `$in` on this can only ever be a hint that skips rows the predicate
 * would reject anyway, never a substitute for the `currentPeriodEnd` check below.
 */
export const ENTITLING_STATUSES = ['active', 'trialing'] as const

const ENTITLING_STATUS_SET: ReadonlySet<string> = new Set(ENTITLING_STATUSES)

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
  if (!sub || !ENTITLING_STATUS_SET.has(sub.status)) return false
  // Absent before Stripe has billed the first period; the status alone carries it then.
  return !sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() > now.getTime()
}

export type TierStanding = {
  entitled: boolean
  /** The tier this viewer may actually watch through. Null unless `entitled`. */
  heldTierId: string | null
  /** A tier a checkout was opened for and never paid. Null once `entitled`. */
  pendingTierId: string | null
}

/**
 * Separate the tier a subscription row *names* from the tier it actually buys.
 *
 * `startChannelCheckout` writes the row before handing the viewer to Stripe, so that
 * the channel page can say "payment pending" instead of nothing. The cost is that a
 * row naming a tier proves only that a checkout was opened — abandon it, and the row
 * still sits there at `incomplete` pointing squarely at a tier nobody paid for.
 *
 * Reading that row as membership is a mistake with two heads: it tells the viewer
 * they are subscribed while every gate correctly refuses them, and it hides the
 * button they need to finish paying. So the split lives here, in the module that
 * already owns "what does this row mean", rather than being re-derived by each
 * caller — one of which got it wrong.
 */
export function tierStanding(
  sub: (EntitlementState & { tierId?: string | null }) | null,
  now: Date = new Date(),
): TierStanding {
  const named = sub?.tierId ?? null
  const entitled = isEntitled(sub, now)
  return {
    entitled,
    heldTierId: entitled ? named : null,
    pendingTierId: entitled ? null : named,
  }
}
