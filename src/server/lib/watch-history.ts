import type { Types } from 'mongoose'
// Relative, `.ts`-suffixed imports rather than the `@/` alias, for the same reason as
// `entitlement.ts`: `scripts/test-watch-history.ts` loads this module under plain
// `node --experimental-strip-types`, which resolves neither tsconfig paths nor
// extensionless specifiers. Vite resolves these identically.
import { VideoViewModel } from '../db/models/video-view.ts'
import { NO_SIGNALS, type ViewerSignals } from './feed-ranking.ts'

/**
 * Writing and reading the per-viewer watch record that personalizes the feed.
 *
 * Both halves short-circuit for an anonymous viewer without touching the database.
 * That is the whole answer to "does this slow down playback for a signed-out
 * visitor": it does not reach Mongo at all, the same discipline `getChannelAccess`
 * and `loadPurchasedVideoIds` already follow.
 */

/**
 * How many recent rows the signals read. Enough to describe what a viewer is
 * currently interested in; small enough that the reduction below stays trivial and
 * the query stays a bounded index scan.
 */
const SIGNAL_WINDOW = 200

/**
 * Records that this viewer opened this video.
 *
 * **Never throws.** This is a ranking signal on the playback path, and no failure to
 * record one is worth turning a successful playback into a 500. That explicitly
 * includes the duplicate-key error two concurrent first-watches produce: the loser's
 * increment is lost, the count is off by one, and nothing that reads it cares.
 *
 * Swallowing its own errors is also what makes it safe to `Promise.all` alongside the
 * `viewCount` increment — a rejection there would take the whole array down with it.
 * Do not call this without awaiting: under Nitro the response can finish before an
 * unawaited write flushes.
 *
 * Assumes the caller has already connected to the database.
 */
export async function recordWatch(
  viewerId: string | null,
  video: { _id: Types.ObjectId | string; uploadedBy?: Types.ObjectId | string | null },
): Promise<void> {
  if (!viewerId) return

  try {
    await VideoViewModel.updateOne(
      { viewerId, videoId: video._id },
      {
        $inc: { watchCount: 1 },
        // `creatorId` is set on every watch rather than only on insert. It cannot
        // appear in both `$set` and `$setOnInsert` — Mongo rejects a field in both —
        // and re-setting it is the cheaper way round: it repairs rows written before
        // a video gained an uploader instead of leaving them permanently creatorless.
        $set: { lastWatchedAt: new Date(), creatorId: video.uploadedBy ?? null },
      },
      { upsert: true },
    )
  } catch (error) {
    console.error('recordWatch failed', error)
  }
}

/**
 * This viewer's ranking signals, in one query.
 *
 * `subscribedCreatorIds` is passed in rather than queried here: the feed has already
 * loaded it to build its candidate set, and asking twice for the same answer would be
 * the kind of duplicate query the rest of this file exists to avoid.
 *
 * Anonymous viewers get the empty signals at no cost, which is what makes the feed
 * degrade to recency + trending without a branch anywhere else.
 *
 * Assumes the caller has already connected to the database.
 */
export async function loadViewerSignals(
  viewerId: string | null,
  subscribedCreatorIds: readonly string[],
): Promise<ViewerSignals> {
  if (!viewerId) return { ...NO_SIGNALS, subscribedCreatorIds }

  const rows = await VideoViewModel.find({ viewerId })
    .sort({ lastWatchedAt: -1 })
    .limit(SIGNAL_WINDOW)
    .select('videoId creatorId watchCount')
    .lean()

  const watchedVideoIds: string[] = []
  const creatorWatchCounts: Record<string, number> = {}

  for (const row of rows) {
    watchedVideoIds.push(String(row.videoId))
    if (!row.creatorId) continue
    const creatorId = String(row.creatorId)
    // Summed rather than counted: a viewer who watched one video of a channel five
    // times is saying something about that channel, just less than one who watched
    // five different ones. `affinitySaturation` caps how far either goes.
    creatorWatchCounts[creatorId] = (creatorWatchCounts[creatorId] ?? 0) + (row.watchCount || 1)
  }

  return { watchedVideoIds, creatorWatchCounts, subscribedCreatorIds }
}
