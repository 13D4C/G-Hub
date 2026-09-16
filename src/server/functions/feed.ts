import { createServerFn } from '@tanstack/react-start'
import type { FeedReason } from '@/lib/feed-reason'
import type { VideoSummary } from '@/lib/video-summary-types'
import { getUserId } from '@/server/auth/require-user'
import { VideoModel } from '@/server/db/models/video'
import { connectToDatabase } from '@/server/db/mongoose'
import {
  loadSubscribedCreatorIds,
  visibleToViewerFilter,
  type ChannelAccess,
} from '@/server/lib/entitlement'
import { mergeCandidatePools, rankFeed, type FeedCandidate } from '@/server/lib/feed-ranking'
import { summarizeVideosForViewer, type VideoRow } from '@/server/lib/video-summary'
import { loadViewerSignals } from '@/server/lib/watch-history'

/**
 * The personalized home feed: new uploads from the channels a viewer pays for, mixed
 * with recent videos that are doing well, ordered by how likely each is to be what
 * they came for.
 *
 * Kept apart from `listVideos` rather than added to it as an option. The watch page's
 * "more videos" rail calls `listVideos` bare and wants a plain catalogue — running a
 * subscription lookup and a history read to fill a sidebar is wrong work, and worse,
 * the affinity signal the current video just wrote would rank that same channel to
 * the top of its own rail. Two callers wanting two different things is two functions.
 * It also means rolling this back is a one-line change to the route loader.
 *
 * Every response is specific to one viewer. Nothing caches server-function responses
 * today; if HTTP caching is ever put in front of the document response, this must not
 * be shared between viewers.
 */

/** A feed row: a catalogue row plus the reason it is here. */
export type FeedItem = VideoSummary & { reason: FeedReason }

/**
 * How far back the "what's good lately" pool reaches.
 *
 * This window is what makes a separate trending query unnecessary. Sorting a second
 * pool by `viewCount` would need its own index and would hand the scorer a set
 * already biased toward all-time winners — the exact failure this feed is meant to
 * avoid. Bounding by age instead and letting `rankFeed` decay popularity within the
 * window finds the same videos, and keeps the whole definition of "trending" inside
 * the module that has tests.
 */
const RECENT_WINDOW_DAYS = 90

/** Candidate pool caps. Bounded work per request, regardless of catalogue size. */
const SUBSCRIBED_POOL = 60
const RECENT_POOL = 120

/** How many rows the page actually renders. */
const FEED_SIZE = 30

const VIDEO_FIELDS = 'title description url durationSeconds visibility uploadedBy requiredTierId priceCents createdAt viewCount likeCount'

type CandidateRow = VideoRow & {
  createdAt?: Date
  viewCount?: number
  likeCount?: number
}

export const listFeed = createServerFn({ method: 'GET' }).handler(async (): Promise<FeedItem[]> => {
  const viewerId = await getUserId()
  await connectToDatabase()

  const subscriptions = await loadSubscribedCreatorIds(viewerId)
  const subscribedCreatorIds = subscriptions.map((s) => s.creatorId)

  // Both pools are combined with an explicit `$and` rather than by spreading
  // `visibleToViewerFilter` alongside a second clause. That filter returns an `$or`
  // for a signed-in viewer, and a spread works today only because nothing else in
  // these queries uses `$or` — the day one does, a clause is silently overwritten and
  // the casualty is a private video appearing in a stranger's feed. `$and` costs
  // nothing and removes the trap entirely.
  const visible = visibleToViewerFilter(viewerId)
  const cutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const [subscribedVideos, recentVideos] = await Promise.all([
    subscribedCreatorIds.length === 0
      ? Promise.resolve<CandidateRow[]>([])
      : VideoModel.find({ $and: [visible, { uploadedBy: { $in: subscribedCreatorIds } }] })
          .select(VIDEO_FIELDS)
          .sort({ createdAt: -1 })
          .limit(SUBSCRIBED_POOL)
          .lean<CandidateRow[]>(),
    VideoModel.find({ $and: [visible, { createdAt: { $gte: cutoff } }] })
      .select(VIDEO_FIELDS)
      .sort({ createdAt: -1 })
      .limit(RECENT_POOL)
      .lean<CandidateRow[]>(),
  ])

  // Deduped by id, remembering which pool each row arrived through — see
  // `mergeCandidatePools` for why the subscription answer wins an overlap.
  const merged = mergeCandidatePools(subscribedVideos, recentVideos, (row) => String(row._id))
  const rowById = new Map(merged.map((entry) => [entry.id, entry.row]))

  const signals = await loadViewerSignals(viewerId, subscribedCreatorIds)

  const candidates: FeedCandidate[] = merged.map(({ id, row, fromSubscription }) => ({
    id,
    creatorId: row.uploadedBy ? String(row.uploadedBy) : null,
    // `createdAt` comes from `timestamps: true` and is always written, but a row
    // seeded around the schema would leave it undefined; treating that as "now" would
    // put it at the top of the feed, so it falls to the epoch instead.
    createdAtMs: row.createdAt ? row.createdAt.getTime() : 0,
    viewCount: row.viewCount ?? 0,
    likeCount: row.likeCount ?? 0,
    fromSubscription,
  }))

  const ranked = rankFeed(candidates, signals, Date.now()).slice(0, FEED_SIZE)

  // The viewer's complete subscription set, which is what lets `summarizeVideosForViewer`
  // skip its per-premium-creator `getChannelAccess` query. Sound only because
  // `loadSubscribedCreatorIds` returns *every* channel they pay for, not just the ones
  // on this page — see the invariant documented on that parameter. Ownership is
  // resolved inside the helper, so it is deliberately not represented here.
  const access = new Map<string, ChannelAccess>(
    subscriptions.map((s) => [s.creatorId, { subscribed: true, tierId: s.tierId, isOwner: false }]),
  )

  const summaries = await summarizeVideosForViewer(
    ranked.map((row) => rowById.get(row.id)!),
    viewerId,
    access,
  )

  // Zipped by position: `summarizeVideosForViewer` maps its input one-to-one and in
  // order, so `ranked[i]` and `summaries[i]` are the same video.
  return summaries.map((summary, i) => ({ ...summary, reason: ranked[i].reason }))
})
