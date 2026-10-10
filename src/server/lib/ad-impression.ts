import type { Types } from 'mongoose'
// Relative, `.ts`-suffixed imports rather than the `@/` alias, for the same reason as
// `watch-history.ts`: `scripts/test-revenue-ledger.ts` loads this module under plain
// `node --experimental-strip-types`, which resolves neither tsconfig paths nor
// extensionless specifiers. Vite resolves these identically.
import { AdImpressionModel } from '../db/models/ad-impression.ts'

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
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000
}

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
  video: { _id: Types.ObjectId | string; uploadedBy?: Types.ObjectId | string | null },
  adId: Types.ObjectId | string,
  now: Date = new Date(),
): Promise<void> {
  // Nobody to credit. `videoview` tolerates a creatorless row because a ranking
  // signal without a channel is still a usable signal; a revenue row without one is
  // money owed to no one, and would only inflate a total nobody can see.
  if (!video.uploadedBy) return

  try {
    await AdImpressionModel.create({
      adId,
      videoId: video._id,
      creatorId: video.uploadedBy,
      viewerId: viewerId ?? null,
      shownAt: now,
      // Omitted entirely for an anonymous viewer, never set to null: the index is
      // sparse, so a missing field is skipped, but an explicit null *is* indexed and
      // would collapse every anonymous impression in the system into one row. See the
      // note on the field in `models/ad-impression.ts`.
      ...(viewerId
        ? {
            dedupeKey: `${viewerId}:${String(video._id)}:${String(adId)}:${Math.floor(
              now.getTime() / DEDUPE_WINDOW_MS,
            )}`,
          }
        : {}),
    })
  } catch (error) {
    // E11000 is the expected path, not a failure: the second view of a video inside
    // the window is *supposed* to hit the unique index and write nothing. It is not
    // logged, because `getVideoById` re-runs on every reload and back navigation, so
    // logging it produced a steady flood that buried the failures worth reading.
    // Anything else is a real write failure and is still reported.
    if (isDuplicateKeyError(error)) return
    console.error('recordAdImpression failed', error)
  }
}
