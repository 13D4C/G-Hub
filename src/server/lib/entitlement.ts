import { INTERACTION_ERRORS } from '@/lib/interaction-errors'
import { SubscriptionModel } from '@/server/db/models/subscription'
import { VideoModel } from '@/server/db/models/video'
import { isEntitled } from '@/server/lib/entitlement-status'

/**
 * Who is allowed to watch what. Every playback and interaction handler routes through
 * `requirePlayableVideo`, so the rule "public is open, private needs a plan" exists in
 * exactly one place — a second copy is how a subscriber ends up able to watch a video
 * but not like it.
 */

// One import site for callers that only need the predicate.
export { isEntitled }

/**
 * Whether this viewer currently has an active plan. Anonymous viewers never do, and
 * answering that costs no query.
 *
 * Assumes the caller has already connected to the database.
 */
export async function hasActiveSubscription(userId: string | null): Promise<boolean> {
  if (!userId) return false

  const sub = await SubscriptionModel.findOne({ userId })
    .select('status currentPeriodEnd')
    .lean()
  return isEntitled(sub ?? null)
}

/**
 * The video, if this viewer may watch it, plus whether they are subscribed — the
 * caller needs the second answer to decide about ads and would otherwise re-query.
 *
 * A missing video and a private one give different messages on purpose: `visibility`
 * is not a secret here (a private video is a paywalled one, not a hidden one), and
 * telling the viewer to subscribe is the entire point of the paywall.
 *
 * Assumes the caller has already connected to the database.
 */
export async function requirePlayableVideo(videoId: string, viewerId: string | null) {
  const video = await VideoModel.findById(videoId).lean()
  if (!video) throw new Error(INTERACTION_ERRORS.videoNotFound)

  const subscribed = await hasActiveSubscription(viewerId)
  if (video.visibility !== 'public' && !subscribed) {
    throw new Error(INTERACTION_ERRORS.subscriptionRequired)
  }

  return { video, subscribed }
}
