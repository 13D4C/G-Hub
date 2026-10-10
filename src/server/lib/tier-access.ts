/**
 * The ladder rule: does the tier a viewer holds open the tier a video demands?
 *
 * Alone in a module with no imports, for the same reason as `entitlement-status.ts`
 * — `scripts/test-tier-access.ts` imports it under plain `node
 * --experimental-strip-types`, which resolves neither the `@/` alias nor Mongoose.
 *
 * This decides *which* premium video a subscriber may watch. Whether they are a
 * subscriber at all is `isEntitled`'s question, and both must pass.
 */

export type TierRef = {
  id: string
  /**
   * Null when the tier row could not be found — archived tiers still resolve, so
   * this means genuinely gone. Treated as "no comparable position on the ladder"
   * rather than as rank 0, which would silently open every gate above it.
   */
  rank: number | null
}

/**
 * Whether `held` satisfies `required`.
 *
 * - No `required`: the video is gated by subscription alone, so any tier opens it,
 *   including the null tier of a channel-level subscription.
 * - No `held` (a channel-level or pre-tiers subscription) against a tier gate:
 *   denied. Fail-closed is the right way round — a creator who adds tiers and gates
 *   a video behind Gold has said something specific, and reading that as "everyone
 *   who ever subscribed" would give away what they just put a price on.
 * - Otherwise the exact tier always opens its own gate, and a higher or equal rank
 *   opens a lower one.
 */
export function tierUnlocks(held: TierRef | null, required: TierRef | null): boolean {
  if (!required) return true
  if (!held) return false
  if (held.id === required.id) return true
  // A gate naming a vanished tier, or a subscription holding one, has no position to
  // compare; only the exact-id match above can open it.
  if (held.rank === null || required.rank === null) return false
  return held.rank >= required.rank
}
