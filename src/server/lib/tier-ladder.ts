import { membershipTiers, videos } from '@/server/data'

/**
 * Reading a creator's membership ladder — shared by `listMyMembershipTiers` and by
 * `getChannel`, which render the same rungs to the creator and to a viewer.
 *
 * It lives in `server/lib` rather than beside the server functions that use it
 * because it is a *plain* exported function, and `src/server/functions/*` may only
 * export `createServerFn` values and types. Vite strips a server function's body
 * from the client bundle; it leaves an ordinary export alone, so exporting this from
 * there pulled `MembershipTierModel` — and all of Mongoose behind it — into the
 * browser, where it fails to evaluate at all.
 */

export type MembershipTierView = {
  id: string
  name: string
  description: string
  /** Minor units (cents). */
  priceCents: number
  currency: string
  /** Higher unlocks lower. */
  rank: number
  /** How many of this creator's videos are gated behind exactly this tier. */
  videoCount: number
}

/**
 * The creator's live ladder, lowest rung first, with the number of videos each rung
 * gates.
 *
 * The counts come from one grouped scan of that creator's videos rather than a query
 * per tier, and they are what stops a creator from archiving a tier without noticing
 * they just orphaned four videos' gates.
 *
 * Assumes the caller has already connected to the database.
 */
export async function readLadder(
  creatorId: string,
): Promise<Array<MembershipTierView>> {
  const tiers = await membershipTiers.listActiveByCreator(String(creatorId))
  if (tiers.length === 0) return []

  const countByTier = await videos.countByTier(tiers.map((t) => t.id))

  return tiers.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    priceCents: t.priceCents,
    currency: t.currency,
    rank: t.rank,
    videoCount: countByTier.get(t.id) ?? 0,
  }))
}
