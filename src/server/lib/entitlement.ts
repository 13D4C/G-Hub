import type { Types } from 'mongoose'
// Relative, `.ts`-suffixed imports rather than the `@/` alias the rest of the app
// uses: `scripts/test-channel-gate.ts` imports this module under plain `node
// --experimental-strip-types`, which resolves neither tsconfig paths nor extensionless
// specifiers. Vite resolves these identically, so nothing else changes — but rewriting
// them back to `@/` breaks that check.
import { INTERACTION_ERRORS } from '../../lib/interaction-errors.ts'
import { ChannelSubscriptionModel } from '../db/models/channel-subscription.ts'
import { MembershipTierModel } from '../db/models/membership-tier.ts'
import { VideoModel } from '../db/models/video.ts'
import { VideoPurchaseModel } from '../db/models/video-purchase.ts'
import { ENTITLING_STATUSES, isEntitled, tierStanding } from './entitlement-status.ts'
import { tierUnlocks, type TierRef } from './tier-access.ts'

/**
 * Who is allowed to watch what. Every playback and interaction handler routes through
 * `requirePlayableVideo`, so the rules — public is open, `subscriber` needs a
 * subscription to that channel and the right tier, `buyer` needs a purchase of that
 * one video, and `private` is the uploader's alone — exist in exactly one place. A
 * second copy is how a subscriber ends up able to watch a video but not like it.
 *
 * The two paid states are alternatives, not a ladder. A subscription buys the
 * `subscriber` videos of one channel; a purchase buys one `buyer` video outright.
 * Neither opens the other, and only the creator clears both without paying.
 */

// One import site for callers that only need the predicates.
export { isEntitled, tierStanding, tierUnlocks }

/**
 * What one viewer may do on one channel: whether they are paying at all, and which
 * rung of the ladder they are paying for.
 */
export type ChannelAccess = {
  /** An active subscription, or the creator's own channel. */
  subscribed: boolean
  /** The tier held, or null for a channel-level subscription and for non-subscribers. */
  tierId: string | null
  /** The creator, who never pays for their own channel and holds every tier by right. */
  isOwner: boolean
}

const NO_ACCESS: ChannelAccess = { subscribed: false, tierId: null, isOwner: false }

/**
 * This viewer's standing on this channel. Anonymous viewers have none, and answering
 * that costs no query.
 *
 * Assumes the caller has already connected to the database.
 */
export async function getChannelAccess(
  viewerId: string | null,
  creatorId: string | Types.ObjectId | null | undefined,
): Promise<ChannelAccess> {
  if (!viewerId || !creatorId) return NO_ACCESS
  if (viewerId === String(creatorId)) return { subscribed: true, tierId: null, isOwner: true }

  const sub = await ChannelSubscriptionModel.findOne({ subscriberId: viewerId, creatorId })
    .select('status currentPeriodEnd tierId')
    .lean()
  if (!isEntitled(sub ?? null)) return NO_ACCESS

  return { subscribed: true, tierId: sub?.tierId ? String(sub.tierId) : null, isOwner: false }
}

/** One channel a viewer pays for, and the rung they pay for it at. */
export type SubscribedChannel = {
  creatorId: string
  /** The tier held, or null for a channel-level subscription. */
  tierId: string | null
}

/**
 * Every channel this viewer currently pays for, in one query — the inverse of
 * `getChannelAccess`, which answers the same question one channel at a time.
 *
 * The personalized feed needs this to know whose uploads to go looking for, and it is
 * the query that did not exist before: every other read of `channelsubscription` is
 * keyed by a specific `(subscriberId, creatorId)` pair or by `creatorId` alone. The
 * unique `{ subscriberId: 1, creatorId: 1 }` index covers this as a prefix scan, so
 * it needs no index of its own.
 *
 * The `$in` on status only narrows what comes back; `isEntitled` still decides, so an
 * `active` row whose period has quietly expired is rejected here exactly as it would
 * be by `getChannelAccess`. Anonymous viewers pay nobody, and answering that costs no
 * query.
 *
 * Assumes the caller has already connected to the database.
 */
export async function loadSubscribedCreatorIds(
  viewerId: string | null,
  now?: Date,
): Promise<SubscribedChannel[]> {
  if (!viewerId) return []

  const rows = await ChannelSubscriptionModel.find({
    subscriberId: viewerId,
    status: { $in: [...ENTITLING_STATUSES] },
  })
    .select('creatorId tierId status currentPeriodEnd')
    .lean()

  return rows
    .filter((row) => isEntitled(row, now))
    .map((row) => ({
      creatorId: String(row.creatorId),
      tierId: row.tierId ? String(row.tierId) : null,
    }))
}

/**
 * Whether this viewer currently subscribes to this channel, ignoring which tier.
 *
 * Kept for callers that only sell one thing — the channel page's "Subscribed" badge,
 * and the ad decision, since a subscriber of any tier has paid to skip the preroll.
 *
 * Assumes the caller has already connected to the database.
 */
export async function hasActiveChannelSubscription(
  viewerId: string | null,
  creatorId: string | Types.ObjectId | null | undefined,
): Promise<boolean> {
  return (await getChannelAccess(viewerId, creatorId)).subscribed
}

/**
 * Ranks for a set of tier ids, in one query.
 *
 * Archived tiers are included on purpose: a subscriber keeps the rung they bought
 * after the creator retires it, and a video keeps the gate it was given. Only a
 * genuinely deleted tier is missing from the result, and `tierUnlocks` fails closed
 * on that.
 *
 * Assumes the caller has already connected to the database.
 */
export async function loadTierRanks(
  ids: Array<string | Types.ObjectId | null | undefined>,
): Promise<Map<string, number>> {
  const wanted = [...new Set(ids.filter(Boolean).map(String))]
  if (wanted.length === 0) return new Map()

  const tiers = await MembershipTierModel.find({ _id: { $in: wanted } })
    .select('rank')
    .lean()
  return new Map(tiers.map((t) => [String(t._id), t.rank]))
}

/** A tier id paired with the rank a `loadTierRanks` map holds for it. */
export function tierRefOf(
  tierId: string | Types.ObjectId | null | undefined,
  ranks: Map<string, number>,
): TierRef | null {
  if (!tierId) return null
  const id = String(tierId)
  return { id, rank: ranks.get(id) ?? null }
}

/**
 * Whether this standing on the channel opens a video gated behind `requiredTierId`.
 *
 * Pass `ranks` when the caller has already batched the lookup for a page of videos;
 * without it this resolves the two tiers itself.
 *
 * Assumes the caller has already connected to the database.
 */
export async function unlocksTier(
  access: ChannelAccess,
  requiredTierId: string | Types.ObjectId | null | undefined,
  ranks?: Map<string, number>,
): Promise<boolean> {
  // The creator holds every rung of their own ladder without buying one.
  if (access.isOwner) return true
  if (!requiredTierId) return true

  const resolved = ranks ?? (await loadTierRanks([access.tierId, requiredTierId]))
  return tierUnlocks(tierRefOf(access.tierId, resolved), tierRefOf(requiredTierId, resolved))
}

/**
 * Whether this viewer has bought this one video.
 *
 * A purchase is permanent, so there is no period to compare — the row existing *is*
 * the entitlement. Anonymous viewers own nothing, and answering that costs no query.
 *
 * Assumes the caller has already connected to the database.
 */
export async function hasPurchasedVideo(
  viewerId: string | null,
  videoId: string | Types.ObjectId,
): Promise<boolean> {
  if (!viewerId) return false
  return !!(await VideoPurchaseModel.exists({ buyerId: viewerId, videoId }))
}

/**
 * Which of these videos this viewer has bought, in one query — the purchase-side
 * counterpart to `loadTierRanks`, and for the same reason: a catalogue page must not
 * ask once per row.
 *
 * Assumes the caller has already connected to the database.
 */
export async function loadPurchasedVideoIds(
  viewerId: string | null,
  videoIds: Array<string | Types.ObjectId | null | undefined>,
): Promise<Set<string>> {
  if (!viewerId) return new Set()

  const wanted = [...new Set(videoIds.filter(Boolean).map(String))]
  if (wanted.length === 0) return new Set()

  const rows = await VideoPurchaseModel.find({ buyerId: viewerId, videoId: { $in: wanted } })
    .select('videoId')
    .lean()
  return new Set(rows.map((row) => String(row.videoId)))
}

/**
 * The video, if this viewer may watch it, plus their standing on its channel — the
 * caller needs the second answer to render the paywall and would otherwise re-query.
 *
 * A paywalled video and one behind a *higher* tier give different messages on
 * purpose. A `subscriber` video is a paywalled one, not a hidden one; and telling a
 * paying Silver subscriber to "subscribe" when they already have would read as a bug
 * rather than as an upsell. A `buyer` video gets a third message for the same reason:
 * its fix is a one-off purchase, and it is the one rejection a fully paid-up
 * subscriber of the channel can still receive.
 *
 * A `private` video is the exception: it reports as missing rather than as locked.
 * There is nothing to sell, so a distinct message would only confirm to a stranger
 * that the video exists — the same reasoning as `deleteComment`, which refuses to
 * distinguish "gone" from "not yours".
 *
 * Assumes the caller has already connected to the database.
 */
export async function requirePlayableVideo(videoId: string, viewerId: string | null) {
  const video = await VideoModel.findById(videoId).lean()
  if (!video) throw new Error(INTERACTION_ERRORS.videoNotFound)

  // Computed even for a public video: one indexed lookup, and a `subscribed` flag
  // that is only true when the paywall forced it would be a lie the UI reads.
  const access = await getChannelAccess(viewerId, video.uploadedBy)

  // Reported alongside the video because this function has already paid for the
  // answer; a caller that wants to say "you own this" would otherwise re-query for
  // something the gate just decided. Stays false for every visibility but `buyer`,
  // which have their own notion of access.
  let purchased = false

  if (video.visibility === 'private') {
    if (!access.isOwner) throw new Error(INTERACTION_ERRORS.videoNotFound)
  } else if (video.visibility === 'subscriber') {
    if (!access.subscribed) throw new Error(INTERACTION_ERRORS.subscriptionRequired)
    if (!(await unlocksTier(access, video.requiredTierId))) {
      throw new Error(INTERACTION_ERRORS.tierRequired)
    }
  } else if (video.visibility === 'buyer') {
    // Deliberately does not consult `access.subscribed`. Pay-per-view is its own
    // audience: a subscriber buys this video like anybody else, because the creator
    // priced it separately from the membership and honouring the subscription here
    // would give away the thing they just put a price on. The creator is the only
    // bypass — they never pay for their own work.
    purchased = access.isOwner || (await hasPurchasedVideo(viewerId, video._id))
    if (!purchased) throw new Error(INTERACTION_ERRORS.purchaseRequired)
  }

  return { video, purchased, ...access }
}

/**
 * The Mongo filter that hides other people's `private` videos from a catalogue.
 *
 * Kept here beside the gate rather than inlined at each call site: a listing that
 * forgets it would leak a private video's title into the browsable grid, and
 * `requirePlayableVideo` would then refuse to play the thing it just advertised.
 *
 * `private` is the only state hidden here, and that is the decision rather than an
 * omission. A `buyer` video belongs in the catalogue exactly as a `subscriber` one
 * does: it is the shop window, and a paywall nobody can see is not a paywall.
 */
export function visibleToViewerFilter(viewerId: string | null) {
  // `as const` matters: without it the literal widens to `string` and no longer
  // satisfies Mongoose's typed filter for the `visibility` enum.
  const notPrivate = { visibility: { $ne: 'private' as const } }
  return viewerId ? { $or: [notPrivate, { uploadedBy: viewerId }] } : notPrivate
}
