import { queryOptions } from '@tanstack/react-query'
import { listMyMembershipTiers } from '@/server/functions/membership-tiers'

/**
 * The signed-in creator's own membership ladder — read by the upload form and the
 * video table, both of which need it without a `creatorId`.
 *
 * Not keyed by viewer, unlike `channelKeys`: this query *is* the viewer's, and
 * signing out clears the whole cache anyway.
 */
export const membershipTierKeys = {
  mine: ['membershipTiers', 'mine'] as const,
}

export const myMembershipTiersQueryOptions = queryOptions({
  queryKey: membershipTierKeys.mine,
  queryFn: () => listMyMembershipTiers(),
})

/**
 * Kept in sync with `src/server/db/models/membership-tier.ts`. Mirrored rather than
 * imported so the model — and Mongoose with it — never reaches the client bundle,
 * the same reason `interaction-errors.ts` restates `COMMENT_MAX_LENGTH`.
 */
export const MAX_TIERS_PER_CREATOR = 10
export const TIER_NAME_MAX_LENGTH = 40
export const TIER_DESCRIPTION_MAX_LENGTH = 300
/** Stripe's minimum chargeable amount, and the schema's `min` on `priceCents`. */
export const MIN_TIER_PRICE_CENTS = 50

/**
 * The rank to give a new rung: one above the highest that exists, so tiers added in
 * the order a creator thinks of them come out as a ladder rather than a heap.
 */
export function nextTierRank(tiers: Array<{ rank: number }>): number {
  return tiers.reduce((highest, tier) => Math.max(highest, tier.rank + 1), 0)
}

/**
 * What a rung unlocks, in words: itself plus everything below it. The ladder is the
 * one part of tiers a viewer cannot see from the price alone.
 */
export function describeTierAccess(
  tier: { name: string; rank: number },
  tiers: Array<{ name: string; rank: number }>,
): string {
  const below = tiers.filter((t) => t.rank < tier.rank).map((t) => t.name)
  return below.length === 0
    ? `Unlocks ${tier.name} videos.`
    : `Unlocks ${tier.name} videos, plus everything in ${below.join(', ')}.`
}
