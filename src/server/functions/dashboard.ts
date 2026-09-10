import { createServerFn } from '@tanstack/react-start'
import { Types } from 'mongoose'
import { requireUserId } from '@/server/auth/require-user'
import { ChannelSubscriptionModel } from '@/server/db/models/channel-subscription'
import { TipModel } from '@/server/db/models/tip'
import { UserModel } from '@/server/db/models/user'
import { VideoModel } from '@/server/db/models/video'
import { connectToDatabase } from '@/server/db/mongoose'
import { summarizeTotals, type DashboardTotals } from '@/server/lib/dashboard-totals'
import { readLadder, type MembershipTierView } from '@/server/lib/tier-ladder'
import type { VideoVisibility } from '@/lib/video-visibility'

/**
 * The creator dashboard: everything one account's channel has earned and been
 * watched for.
 *
 * Every account is a channel (see `models/user.ts`), so this needs no creator
 * argument — identity comes from the session and you can only ever read your own
 * numbers. That is also the access control: there is no `creatorId` to tamper with.
 */

export type DashboardVideo = {
  id: string
  title: string
  visibility: VideoVisibility
  createdAt: string
  viewCount: number
  likeCount: number
  shareCount: number
  /** Tips sent from this video's page, in minor units. Channel donations are not here. */
  tipCents: number
}

export type CreatorDashboard = {
  channelName: string
  currency: string
  /**
   * What this channel sells, cheapest rung first. Empty means it sells nothing yet.
   *
   * A list rather than the single `priceCents` this used to report: a channel no
   * longer has one price. Membership tiers are the only thing it sells, and
   * quoting just one of them would understate a ladder.
   */
  tiers: Array<MembershipTierView>
  totals: DashboardTotals
  videos: Array<DashboardVideo>
}

export const getCreatorDashboard = createServerFn({ method: 'GET' }).handler(
  async (): Promise<CreatorDashboard> => {
    const creatorId = await requireUserId()
    await connectToDatabase()

    const [creator, tiers, videos, tipsByVideo, subs] = await Promise.all([
      UserModel.findById(creatorId).select('name channelName channelCurrency').lean(),
      // Through the shared reader, so the dashboard and the channel page cannot
      // disagree about what the ladder is.
      readLadder(creatorId),
      VideoModel.find({ uploadedBy: creatorId })
        .select('title visibility createdAt viewCount likeCount shareCount')
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
      // Grouped by video rather than fetched per row, and `null` (a channel
      // donation) groups too — it is what makes the total add up to the tips the
      // channel page shows.
      TipModel.aggregate<{ _id: unknown; total: number; count: number }>([
        // Aggregation does no schema casting, so the id has to be an ObjectId here
        // — a plain string silently matches nothing and every tip total reads zero.
        { $match: { creatorId: new Types.ObjectId(creatorId) } },
        { $group: { _id: '$videoId', total: { $sum: '$amountCents' }, count: { $sum: 1 } } },
      ]),
      // Filtered in JS through the shared predicate instead of a `status` query, so
      // the "what counts as entitled" rule is not restated here — a row whose
      // renewal webhook never landed must not be counted as paying.
      //
      // ponytail: loads every subscription row for this channel. Swap for an
      // aggregate if a channel ever has more subscribers than fit in memory.
      ChannelSubscriptionModel.find({ creatorId })
        .select('status currentPeriodEnd priceCents')
        .lean(),
    ])

    const tipCentsByVideo = new Map(
      tipsByVideo.map((row) => [row._id ? String(row._id) : null, row.total]),
    )
    return {
      channelName: creator?.channelName || creator?.name || 'Your channel',
      currency: creator?.channelCurrency || 'usd',
      tiers,
      totals: summarizeTotals(videos, tipsByVideo, subs),
      videos: videos.map((v) => ({
        id: String(v._id),
        title: v.title,
        visibility: v.visibility as VideoVisibility,
        createdAt: v.createdAt.toISOString(),
        viewCount: v.viewCount ?? 0,
        likeCount: v.likeCount ?? 0,
        shareCount: v.shareCount ?? 0,
        tipCents: tipCentsByVideo.get(String(v._id)) ?? 0,
      })),
    }
  },
)
