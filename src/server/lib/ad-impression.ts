// Relative, `.ts`-suffixed imports rather than the `@/` alias, for the same reason as
// `watch-history.ts`: `scripts/test-revenue-ledger.ts` loads this module under plain
// `node --experimental-strip-types`, which resolves neither tsconfig paths nor
// extensionless specifiers. Vite resolves these identically.
import { adImpressions } from '../data/index.ts'

/**
 * Recording that a preroll ad was actually served, which is the only evidence ad
 * revenue is derived from.
 *
 * Anonymous viewers are recorded too, unlike `recordWatch` — they are most of the
 * audience an ad is shown to, and skipping them would understate the category badly.
 * What they do not get is a dedupe key, for want of anything stable to key on.
 */

/**
 * How long one viewer's impression of one ad on one video counts only once.
 *
 * Thirty minutes because `getVideoById` re-runs whenever the `/video` loader does — a
 * reload, or a client-side navigation back — and none of those is a new impression.
 * It bounds the overcount rather than eliminating it; see the note on the write.
 */
const DEDUPE_WINDOW_MS = 30 * 60 * 1000

/** Mongo's duplicate-key error, raised here by the sparse unique index on `dedupeKey`. */
/**
 * Records that this viewer was shown this ad on this video.
 *
 * **Never throws.** It runs on the playback path, in the same `Promise.all` as the
 * `viewCount` increment, and a rejection there would take the whole array down with
 * it — turning a successful playback into a 500 over a reporting row. That explicitly
 * includes the duplicate-key error the dedupe index raises on a repeat within the
 * window, which is not an error at all but the mechanism working.
 *
 * Do not call this without awaiting: under Nitro the response can finish before an
 * unawaited write flushes.
 *
 * Assumes the caller has already connected to the database.
 */
export async function recordAdImpression(
  viewerId: string | null,
  video: { id: string; uploadedBy?: string | null },
  adId: string,
  now: Date = new Date(),
): Promise<void> {
  // Nobody to credit. `videoview` tolerates a creatorless row because a ranking
  // signal without a channel is still a usable signal; a revenue row without one is
  // money owed to no one, and would only inflate a total nobody can see.
  if (!video.uploadedBy) return

  try {
    await adImpressions.record({
      adId: String(adId),
      videoId: video.id,
      creatorId: video.uploadedBy,
      viewerId: viewerId ?? null,
      shownAt: now,
      dedupeKey: viewerId
        ? `${viewerId}:${video.id}:${adId}:${Math.floor(
            now.getTime() / DEDUPE_WINDOW_MS,
          )}`
        : null,
    })
  } catch (error) {
    console.error('recordAdImpression failed', error)
  }
}
