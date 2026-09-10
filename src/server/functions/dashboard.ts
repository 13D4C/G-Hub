import { createServerFn } from '@tanstack/react-start'
import { Types } from 'mongoose'
import { requireUserId } from '@/server/auth/require-user'
import { ChannelSubscriptionModel } from '@/server/db/models/channel-subscription'
import { TipModel } from '@/server/db/models/tip'
import { UserModel } from '@/server/db/models/user'
import { VideoModel } from '@/server/db/models/video'
import { connectToDatabase } from '@/server/db/mongoose'
import { summarizeTotals, type DashboardTotals } from '@/server/lib/dashboard-totals'

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
  visibility: 'public' | 'private'
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
  /** Minor units; zero means the channel is not selling subscriptions. */
  priceCents: number
  totals: DashboardTotals
  videos: Array<DashboardVideo>
}

export const getCreatorDashboard = createServerFn({ method: 'GET' }).handler(
  async (): Promise<CreatorDashboard> => {
    const creatorId = await requireUserId()
    await connectToDatabase()

    const [creator, videos, tipsByVideo, subs] = await Promise.all([
      UserModel.findById(creatorId)
        .select('name channelName channelCurrency subscriptionPriceCents')
        .lean(),
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
      priceCents: creator?.subscriptionPriceCents ?? 0,
      totals: summarizeTotals(videos, tipsByVideo, subs),
      videos: videos.map((v) => ({
        id: String(v._id),
        title: v.title,
        visibility: v.visibility,
        createdAt: v.createdAt.toISOString(),
        viewCount: v.viewCount ?? 0,
        likeCount: v.likeCount ?? 0,
        shareCount: v.shareCount ?? 0,
        tipCents: tipCentsByVideo.get(String(v._id)) ?? 0,
      })),
    }
  },
)
