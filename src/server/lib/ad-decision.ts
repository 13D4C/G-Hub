import { AdModel } from '@/server/db/models/ad'

export type PrerollAd = {
  id: string
  mediaUrl: string
  durationSeconds: number
  clickThroughUrl: string
  skippableAfterSeconds: number
}

/**
 * Pick a preroll ad to serve. Chooses among active ads using a weighted random
 * draw (higher `weight` = more likely). Returns null when no active ad exists.
 *
 * Assumes the caller has already connected to the database.
 */
export async function pickPrerollAd(): Promise<PrerollAd | null> {
  const ads = await AdModel.find({ active: true }).lean()
  if (ads.length === 0) return null

  const totalWeight = ads.reduce((sum, ad) => sum + Math.max(ad.weight ?? 1, 0), 0)
  // All weights zero/negative — fall back to a uniform pick.
  let target = totalWeight > 0 ? Math.random() * totalWeight : Math.random() * ads.length

  const picked =
    ads.find((ad) => {
      target -= totalWeight > 0 ? Math.max(ad.weight ?? 1, 0) : 1
      return target < 0
    }) ?? ads[ads.length - 1]

  return {
    id: String(picked._id),
    mediaUrl: picked.mediaUrl,
    durationSeconds: picked.durationSeconds,
    clickThroughUrl: picked.clickThroughUrl,
    skippableAfterSeconds: picked.skippableAfterSeconds,
  }
}
