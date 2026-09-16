import type { Types } from 'mongoose'
import type { VideoSummary, VideoChannel } from '@/lib/video-summary-types'
import type { VideoVisibility } from '@/lib/video-visibility'
import { UserModel } from '@/server/db/models/user'
import {
  getChannelAccess,
  loadPurchasedVideoIds,
  loadTierRanks,
  tierRefOf,
  type ChannelAccess,
} from '@/server/lib/entitlement'
import { isUnlocked } from '@/server/lib/video-unlock'

/**
 * Turning a page of video documents into catalogue rows, with this viewer's locks
 * already resolved.
 *
 * Extracted from `listVideos` so the feed can reuse it rather than become a third
 * copy of the same batching. The batching is the point: a catalogue must not ask a
 * question per row, and the naive version of this issues two queries per premium
 * video on the page.
 *
 * What this does *not* do is decide which videos belong on the page. That is
 * `visibleToViewerFilter`'s job and it stays at the query, because a listing that
 * forgets it leaks a private video's title.
 */

/** A reference to another document, as a `.lean()` row reports it. */
type Ref = Types.ObjectId | string | null | undefined

/** The fields of a video document this needs. A `.lean()` row satisfies it. */
export type VideoRow = {
  _id: Types.ObjectId | string
  title: string
  description: string
  url: string
  durationSeconds: number
  visibility: string
  uploadedBy?: Ref
  requiredTierId?: Ref
  priceCents?: number | null
}

export function channelFrom(creator: {
  _id: unknown
  name?: string
  channelName?: string
  channelCurrency?: string
}): VideoChannel {
  return {
    creatorId: String(creator._id),
    name: creator.channelName || creator.name || 'Untitled channel',
    currency: creator.channelCurrency || 'usd',
  }
}

/**
 * Catalogue rows for these videos, seen through this viewer's entitlement.
 *
 * `access` lets a caller that has already loaded the viewer's complete subscription
 * set hand it over instead of having this ask again. The feed does exactly that, and
 * it is the difference between a constant number of queries and one per premium
 * creator on the page.
 *
 * The invariant that makes it sound: **a creator absent from the map is treated as
 * unsubscribed**, so the map must be built from the viewer's *complete* set of
 * subscriptions, not from a subset that happens to cover the current page. Ownership
 * is resolved here rather than by the caller, so no caller can forget it. If the map
 * is ever wrong the failure is fail-closed — a video the viewer has paid for renders
 * locked, which is a bug they will report, rather than one they never see.
 *
 * Omit it and this batches `getChannelAccess` per premium creator, as `listVideos`
 * always has.
 *
 * Assumes the caller has already connected to the database.
 */
export async function summarizeVideosForViewer(
  videos: VideoRow[],
  viewerId: string | null,
  access?: Map<string, ChannelAccess>,
): Promise<VideoSummary[]> {
  // One `$in` for every creator on the page rather than a lookup per row — the same
  // shape `listComments` uses for author names, and for the same reason.
  // Filter before stringifying: a video with no `uploadedBy` would otherwise become
  // the literal string "undefined", which survives `Boolean` and makes the `$in` a
  // CastError that takes the whole home page down.
  const creatorIds = [...new Set(videos.filter((v) => v.uploadedBy).map((v) => String(v.uploadedBy)))]
  const creators = await UserModel.find({ _id: { $in: creatorIds } })
    .select('name channelName channelCurrency')
    .lean()
  const channelById = new Map(creators.map((c) => [String(c._id), channelFrom(c)]))

  // Asked once per *channel* that actually sells something on this page, not once
  // per row, and through the shared helper so the rule (a creator is entitled to
  // their own channel) is not restated here. Skipped entirely when the caller
  // already knows the answer for every channel.
  const premiumCreators = [
    ...new Set(
      videos
        .filter((v) => v.visibility === 'subscriber' && v.uploadedBy)
        .map((v) => String(v.uploadedBy)),
    ),
  ]
  const accessEntries: Array<readonly [string, ChannelAccess]> = access
    ? premiumCreators.map((id) => [id, accessFor(access, id, viewerId)] as const)
    : await Promise.all(
        premiumCreators.map(async (id) => [id, await getChannelAccess(viewerId, id)] as const),
      )
  const accessTo = new Map(accessEntries)

  // Every tier this page has to compare — the ones the viewer holds and the ones the
  // rows demand — resolved in one query rather than two per premium row.
  const ranks = await loadTierRanks([
    ...accessEntries.map(([, entry]) => entry.tierId),
    ...videos.map((v) => v.requiredTierId),
  ])

  // And every pay-per-view row on the page in one more query, for the same reason.
  // Deliberately not folded into `accessTo`: `getChannelAccess` is a query per
  // channel and its answer is irrelevant here, since a purchase is per video and
  // ownership is a string compare.
  const purchasedIds = await loadPurchasedVideoIds(
    viewerId,
    videos.filter((v) => v.visibility === 'buyer').map((v) => v._id),
  )

  return videos.map((v) => {
    const creatorId = v.uploadedBy ? String(v.uploadedBy) : null
    const visibility = v.visibility as VideoVisibility
    const premium = visibility === 'subscriber'
    const payPerView = visibility === 'buyer'
    const entry = creatorId ? accessTo.get(creatorId) : undefined
    const isOwner = !!viewerId && creatorId === viewerId

    const unlocked = isUnlocked({
      visibility,
      isOwner,
      subscribed: !!entry?.subscribed,
      heldTier: tierRefOf(entry?.tierId ?? null, ranks),
      requiredTier: tierRefOf(v.requiredTierId, ranks),
      purchased: purchasedIds.has(String(v._id)),
    })

    return {
      id: String(v._id),
      title: v.title,
      description: v.description,
      url: unlocked ? v.url : '',
      durationSeconds: v.durationSeconds,
      visibility,
      premium,
      payPerView,
      priceCents: payPerView ? (v.priceCents ?? null) : null,
      unlocked,
      channel: creatorId ? (channelById.get(creatorId) ?? null) : null,
    }
  })
}

/**
 * This viewer's standing on one channel, read from a caller-supplied map.
 *
 * Ownership is decided here rather than expected in the map: a creator is entitled
 * to their own channel whether or not a subscription row exists for them, and that
 * is the rule most easily lost when a caller builds the map from a subscription
 * query alone.
 */
function accessFor(
  access: Map<string, ChannelAccess>,
  creatorId: string,
  viewerId: string | null,
): ChannelAccess {
  if (viewerId && viewerId === creatorId) {
    return { subscribed: true, tierId: null, isOwner: true }
  }
  return access.get(creatorId) ?? { subscribed: false, tierId: null, isOwner: false }
}
