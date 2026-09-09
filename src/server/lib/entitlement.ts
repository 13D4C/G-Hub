import type { Types } from 'mongoose'
// Relative, `.ts`-suffixed imports rather than the `@/` alias the rest of the app
// uses: `scripts/test-channel-gate.ts` imports this module under plain `node
// --experimental-strip-types`, which resolves neither tsconfig paths nor extensionless
// specifiers. Vite resolves these identically, so nothing else changes — but rewriting
// them back to `@/` breaks that check.
import { INTERACTION_ERRORS } from '../../lib/interaction-errors.ts'
import { ChannelSubscriptionModel } from '../db/models/channel-subscription.ts'
import { VideoModel } from '../db/models/video.ts'
import { isEntitled } from './entitlement-status.ts'

/**
 * Who is allowed to watch what. Every playback and interaction handler routes through
 * `requirePlayableVideo`, so the rule "public is open, premium needs a subscription to
 * that channel" exists in exactly one place — a second copy is how a subscriber ends
 * up able to watch a video but not like it.
 */

// One import site for callers that only need the predicate.
export { isEntitled }

/**
 * Whether this viewer currently subscribes to this channel. Anonymous viewers never
 * do, and answering that costs no query. A creator is always entitled to their own
 * channel, so nobody has to pay to watch their own upload.
 *
 * Assumes the caller has already connected to the database.
 */
export async function hasActiveChannelSubscription(
  viewerId: string | null,
  creatorId: string | Types.ObjectId | null | undefined,
): Promise<boolean> {
  if (!viewerId || !creatorId) return false
  if (viewerId === String(creatorId)) return true

  const sub = await ChannelSubscriptionModel.findOne({ subscriberId: viewerId, creatorId })
    .select('status currentPeriodEnd')
    .lean()
  return isEntitled(sub ?? null)
}

/**
 * The video, if this viewer may watch it, plus whether they subscribe to its channel
 * — the caller needs the second answer to render the paywall and would otherwise
 * re-query.
 *
 * A missing video and a locked one give different messages on purpose: a premium
 * video is a paywalled one, not a hidden one, and telling the viewer to subscribe is
 * the entire point of the paywall.
 *
 * Assumes the caller has already connected to the database.
 */
export async function requirePlayableVideo(videoId: string, viewerId: string | null) {
  const video = await VideoModel.findById(videoId).lean()
  if (!video) throw new Error(INTERACTION_ERRORS.videoNotFound)

  // Computed even for a public video: one indexed lookup, and a `subscribed` flag
  // that is only true when the paywall forced it would be a lie the UI reads.
  const subscribed = await hasActiveChannelSubscription(viewerId, video.uploadedBy)
  if (video.visibility !== 'public' && !subscribed) {
    throw new Error(INTERACTION_ERRORS.subscriptionRequired)
  }

  return { video, subscribed }
}
