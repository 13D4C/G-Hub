import { createServerFn } from '@tanstack/react-start'
import { requireUserId } from '@/server/auth/require-user'
import {
  channelSubscriptions,
  tips,
  users,
  videoPurchases,
  videos as videoRepo,
} from '@/server/data'
import { connectToDatabase } from '@/server/db/mongoose'
import { summarizeTotals, type DashboardTotals } from '@/server/lib/dashboard-totals'
import { readLadder, type MembershipTierView } from '@/server/lib/tier-ladder'
import type { TranscodeStatus } from '@/lib/transcode-status'
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
  description: string
  durationSeconds: number
  visibility: VideoVisibility
  requiredTierId: string | null
  priceCents: number | null
  createdAt: string
  viewCount: number
  likeCount: number
  shareCount: number
  /**
   * How far this video has got through transcoding. Creator-facing only — a viewer is
   * never shown it, because the video plays in every one of these states.
   *
   * Null for a video uploaded before the pipeline existed. Those are not queued and will
   * not become queued on their own; `npm run backfill:transcode` is what moves them in.
   */
  transcodeStatus: TranscodeStatus | null
  /** Tips sent from this video's page, in minor units. Channel donations are not here. */
  tipCents: number
  /** What this video has earned in pay-per-view sales, in minor units. */
  saleCents: number
  /** How many times it has been bought. */
  saleCount: number
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

    const [creator, tiers, videos, tipsByVideo, salesByVideo, subs] = await Promise.all([
      users.findById(creatorId),
      // Through the shared reader, so the dashboard and the channel page cannot
      // disagree about what the ladder is.
      readLadder(creatorId),
      videoRepo.listByCreator(creatorId, 100),
      // Grouped by video rather than fetched per row, and `null` (a channel
      // donation) groups too — it is what makes the total add up to the tips the
      // channel page shows.
      tips.listByCreator(creatorId),
      // The same grouping for pay-per-view sales. Every purchase row is money that
      // actually arrived — see `models/video-purchase.ts` — so no status filter, and
      // unlike tips every group has a video, so these always add up to the rows.
      videoPurchases.listByCreator(creatorId),
      // Filtered in JS through the shared predicate instead of a `status` query, so
      // the "what counts as entitled" rule is not restated here — a row whose
      // renewal webhook never landed must not be counted as paying.
      //
      // ponytail: loads every subscription row for this channel. Swap for an
      // aggregate if a channel ever has more subscribers than fit in memory.
      channelSubscriptions.listByCreator(creatorId),
    ])

    const tipCentsByVideo = new Map<string | null, number>()
    for (const row of tipsByVideo) {
      tipCentsByVideo.set(row.videoId, (tipCentsByVideo.get(row.videoId) ?? 0) + row.amountCents)
    }

    const salesByVideoId = new Map<string, { total: number; count: number }>()
    for (const row of salesByVideo) {
      if (!row.videoId) continue
      const existing = salesByVideoId.get(row.videoId) ?? { total: 0, count: 0 }
      existing.total += row.amountCents
      existing.count += 1
      salesByVideoId.set(row.videoId, existing)
    }
    return {
      channelName: creator?.channelName || creator?.name || 'Your channel',
      currency: creator?.channelCurrency || 'usd',
      tiers,
      totals: summarizeTotals(videos, tipsByVideo, salesByVideo, subs),
      videos: videos.map((v) => ({
        id: v.id,
        title: v.title,
        description: v.description,
        durationSeconds: v.durationSeconds,
        visibility: v.visibility as VideoVisibility,
        requiredTierId: v.requiredTierId ? String(v.requiredTierId) : null,
        priceCents: v.priceCents ?? null,
        createdAt: v.createdAt.toISOString(),
        viewCount: v.viewCount ?? 0,
        likeCount: v.likeCount ?? 0,
        shareCount: v.shareCount ?? 0,
        transcodeStatus: (v.transcode?.status as TranscodeStatus | undefined) ?? null,
        tipCents: tipCentsByVideo.get(v.id) ?? 0,
        saleCents: salesByVideoId.get(v.id)?.total ?? 0,
        saleCount: salesByVideoId.get(v.id)?.count ?? 0,
      })),
    }
  },
)
