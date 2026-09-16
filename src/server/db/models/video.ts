import mongoose, { type InferSchemaType, type Model } from 'mongoose'
// Relative and `.ts`-suffixed rather than the `@/` alias, for the same reason
// `src/server/lib/entitlement.ts` does it: the maintenance and test scripts import
// this model under plain `node --experimental-strip-types`, which resolves neither
// tsconfig paths nor extensionless specifiers.
import { VIDEO_VISIBILITIES } from '../../../lib/video-visibility.ts'

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
    // ponytail: counts loads, not unique viewers — a reload counts again. Add a
    // per-(viewer, video, day) collection if the number ever has to mean people.
    viewCount: { type: Number, default: 0 },
    // Incremented by `recordShare`. Shares are anonymous, so unlike likes there is no
    // per-viewer document to store and no per-viewer state to render.
    shareCount: { type: Number, default: 0 },
  },
  { timestamps: true },
)

export type Video = InferSchemaType<typeof videoSchema> & { _id: mongoose.Types.ObjectId }

export const VideoModel: Model<Video> =
  (mongoose.models.video as Model<Video>) ?? mongoose.model<Video>('video', videoSchema)
