import mongoose, { type InferSchemaType, type Model } from 'mongoose'
// Relative and `.ts`-suffixed rather than the `@/` alias, for the same reason
// `src/server/lib/entitlement.ts` does it: the maintenance and test scripts import
// this model under plain `node --experimental-strip-types`, which resolves neither
// tsconfig paths nor extensionless specifiers.
import { VIDEO_VISIBILITIES } from '../../../lib/video-visibility.ts'
import { TRANSCODE_STATUSES } from '../../../lib/transcode-status.ts'

/**
 * One rung of the ladder as it was actually encoded.
 *
 * Its own schema rather than an inline object literal, because that is the only
 * spelling Mongoose reads `_id: false` from — written inline, `_id` becomes a *path*
 * of type `false` and every rendition carries a pointless ObjectId of its own.
 *
 * The player never reads this: the manifest carries the same facts and is the runtime
 * source of truth, so this is allowed to be approximate. It exists so a maintenance
 * script can describe what a video produced without fetching and parsing a manifest.
 */
const renditionSchema = new mongoose.Schema(
  { width: Number, height: Number, bitrateKbps: Number },
  { _id: false },
)

const videoSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    url: { type: String, required: true },
    // The uploader, and therefore the channel this video belongs to — a channel has
    // no identity of its own, it is the creator (see `user.channelName`). Indexed
    // because both the channel page and the paywall look videos up by it. Absent on
    // videos seeded before uploads existed; those stay public-only, since a premium
    // video with no creator would be a paywall no subscription can open.
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'user', index: true },
    durationSeconds: { type: Number, default: 0 },
    /**
     * Who may watch, from open to closed:
     *
     * - `public` — anyone, signed in or not.
     * - `subscriber` — an active subscriber of `uploadedBy`, narrowed further by
     *   `requiredTierId` when one is set.
     * - `buyer` — whoever has bought this one video, permanently, for `priceCents`.
     *   Sold per video rather than per channel, and deliberately not opened by a
     *   subscription: the two paywalled states are alternatives, not a ladder.
     * - `private` — the uploader alone. Left out of every catalogue and reported as
     *   missing to everybody else, so it never advertises its own existence.
     *
     * `subscriber` was previously spelled `private`, so the word changed meaning
     * rather than gaining one. `scripts/migrate-video-visibility.ts` moves the old
     * rows across; without it a paid video would silently become creator-only.
     */
    visibility: { type: String, enum: VIDEO_VISIBILITIES, default: 'public', index: true },
    /**
     * The membership tier this video is gated behind, or null for "any active
     * subscriber". Only consulted when `visibility` is `subscriber` — a public video
     * is open to everyone and a private one is open to nobody, so a tier on either
     * would be a rule nothing reads.
     *
     * Holding a *higher* tier opens it too; the ladder comparison lives in
     * `src/server/lib/tier-access.ts`. Null is the default so every video that
     * existed before tiers keeps behaving exactly as it did.
     */
    requiredTierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'membershipTier',
      default: null,
    },
    /**
     * What one permanent purchase of this video costs, in minor units of the
     * creator's `channelCurrency`. Only consulted when `visibility` is `buyer`, and
     * null for every other state — a price on a public video would be a rule nothing
     * reads, exactly as a tier on one would be. The two write paths
     * (`createVideo` and `updateVideoAccess`) clear it on the same discipline.
     *
     * No `min`/`max` here, for the same reason the counters below carry none:
     * Mongoose validators do not run on update operators, so they would be inert
     * against the `$set` in `updateVideoAccess` and would only imply a guarantee that
     * isn't there. The real bounds live in `src/lib/video-price.ts` and are applied by
     * both write paths.
     */
    priceCents: { type: Number, default: null },
    // Whether a preroll ad is served before this video.
    adsEnabled: { type: Boolean, default: true },
    // Denormalized from the `videolikes` collection, which stays the source of truth.
    // Kept current by `toggleVideoLike` so reading the interaction summary never has
    // to count rows; `npm run recount-likes` reconciles it.
    //
    // No `min: 0` on either counter: Mongoose validators do not run on update
    // operators, so it would be inert against `$inc` and would only imply a
    // guarantee that isn't there.
    likeCount: { type: Number, default: 0 },
    // Incremented once per successful `getVideoById`, which is the only path that
    // hands out a playable url. Anonymous like shares, so no per-viewer document.
    //
    // Caveat: counts loads, not unique viewers — a reload counts again. `videoview`
    // now records the per-(viewer, video) pair, but for feed affinity rather than to
    // correct this number, and it expires after 90 days — so it is not a source this
    // could be recomputed from. Making this mean people still needs its own record.
    viewCount: { type: Number, default: 0 },
    // Incremented by `recordShare`. Shares are anonymous, so unlike likes there is no
    // per-viewer document to store and no per-viewer state to render.
    shareCount: { type: Number, default: 0 },
    /**
     * Where this video is in the HLS/DASH pipeline, and what the pipeline produced.
     *
     * Embedded rather than a `transcodejob` collection because the relationship is 1:1
     * and every read that plays a video is already a read of this — the player needs it
     * to choose a source. A separate collection would add a query to the playback path
     * and a fourth cascade to `deleteVideo` that a crash could orphan. It would start
     * paying only if a second kind of job appeared, or if an operator screen needed
     * per-attempt history.
     *
     * Absent entirely on every video uploaded before this pipeline, and that absence is
     * load-bearing: a missing `transcode` means "plain MP4, play `url`", so this ships
     * without touching a single existing row and `npm run backfill:transcode` opts them
     * in afterwards. Read it with optional chaining — `.lean()` does not apply defaults,
     * so a legacy row really does come back with the whole path missing.
     */
    transcode: {
      /**
       * `pending`    — queued; claimable once `nextAttemptAt` has passed.
       * `processing` — a worker holds a lease on it that expires at `nextAttemptAt`.
       * `ready`      — `hlsUrl`/`dashUrl` are playable.
       * `failed`     — out of attempts. The MP4 keeps playing and no viewer is blocked.
       * `skipped`    — deliberately not transcoded (over the size cap, or unreadable).
       *                Distinct from `failed` so `--reset-failed` does not sweep it up.
       *
       * Never consulted by the paywall. `requirePlayableVideo` is the only authority on
       * who may watch, and it does not read this.
       */
      status: { type: String, enum: TRANSCODE_STATUSES, default: 'pending' },
      /**
       * When this row becomes claimable again — one field doing three jobs, which is the
       * point. It is the initial queue position, the lease expiry while a worker holds
       * it, and the backoff delay after a failure. A worker killed mid-encode therefore
       * needs no reaper: its lease simply runs out and the claim query matches the row
       * again.
       */
      nextAttemptAt: { type: Date, default: Date.now },
      /**
       * Incremented on *claim*, not on failure. A worker killed by the OOM reaper or by
       * a redeploy never gets to record its own failure, so counting claims is the only
       * version of this that terminates a crash loop.
       */
      attempts: { type: Number, default: 0 },
      /**
       * Who holds the lease. Every write that finishes a job is conditioned on it, so a
       * worker whose lease expired mid-encode cannot overwrite the result of the worker
       * that took the job over.
       */
      workerId: { type: String, default: '' },
      /**
       * The random path segment this attempt's output lives under, inside
       * `videos/{_id}/`. Minted fresh by every claim.
       *
       * Random rather than derived from the video id, as defence in depth. Access is
       * gated by the signed `/api/media` urls (`src/server/lib/media-url.ts`), but a
       * bucket that still answers anonymous reads would make a predictable
       * `videos/{_id}/stream/master.m3u8` derivable from the id in the `/video?id=` URL
       * every visitor already sees — handing away every `buyer` and `subscriber` video.
       * `createVideo` buys the same obscurity with a UUID in the key; this keeps it.
       *
       * A fresh segment per attempt also means a retry cannot interleave its output with
       * a dead attempt's — the old tree is simply orphaned, and swept on the next success.
       */
      prefix: { type: String, default: '' },
      /** The HLS master playlist. Empty until `ready`. */
      hlsUrl: { type: String, default: '' },
      /** The DASH manifest. Points at the same CMAF segments the HLS playlists do. */
      dashUrl: { type: String, default: '' },
      /** What the ladder actually produced, for operator reporting. */
      renditions: { type: [renditionSchema], default: [] },
      /**
       * Probed from the file rather than taken from the form. `createVideo` reads
       * `durationSeconds` off client-supplied FormData and believes it; once a video has
       * been probed these are the honest numbers, and the worker corrects the top-level
       * `durationSeconds` with the probed one.
       */
      sourceWidth: { type: Number, default: 0 },
      sourceHeight: { type: Number, default: 0 },
      /** The last failure, truncated. Operator-facing only; never shown to a viewer. */
      error: { type: String, default: '' },
      startedAt: { type: Date, default: null },
      finishedAt: { type: Date, default: null },
    },
  },
  { timestamps: true },
)

// Every index must stay above `mongoose.model(...)`: indexes declared after the
// model is compiled are silently dropped. Same warning as on `videolike`.

/**
 * A channel's videos, newest first — the personalized feed's subscribed-uploads
 * query, and also what `listMyVideos` and the channel page have always asked for.
 * Those two sort `{ createdAt: -1 }` within a single `uploadedBy`, which the
 * field-level index above cannot serve, so both have been paying for an in-memory
 * sort until now.
 *
 * This supersedes the standalone `uploadedBy` index, which is deliberately left in
 * place: dropping an index is a separate decision with its own deploy ordering, and
 * a redundant index costs writes, not correctness.
 */
videoSchema.index({ uploadedBy: 1, createdAt: -1 })

/**
 * The catalogue's own order. `listVideos` has always sorted on `createdAt` with
 * nothing to serve it, which is an in-memory sort of the whole collection — not
 * merely slow, but a hard failure once the sorted set passes Mongo's 32MB limit.
 * The feed's recency window reads through the same index.
 */
videoSchema.index({ createdAt: -1 })

/**
 * The transcode worker's claim: the oldest row whose lease or backoff has expired.
 *
 * Leading field is `status` because the claim matches `$in: ['pending', 'processing']`
 * — two point values, which Mongo serves as two index scans merged in
 * `transcode.nextAttemptAt` order, so this one index serves the sort as well as the
 * filter. Without it the claim is a collection scan on every poll of every worker.
 *
 * Deliberately not a partial index on the two live states: a claim query that silently
 * stopped using its index would be worse than an index carrying some settled rows.
 */
videoSchema.index({ 'transcode.status': 1, 'transcode.nextAttemptAt': 1 })

export type Video = InferSchemaType<typeof videoSchema> & { _id: mongoose.Types.ObjectId }

export const VideoModel: Model<Video> =
  (mongoose.models.video as Model<Video>) ?? mongoose.model<Video>('video', videoSchema)
