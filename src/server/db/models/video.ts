import mongoose, { type InferSchemaType, type Model } from 'mongoose'

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
    // `private` means premium: playable only by an active subscriber of `uploadedBy`.
    visibility: { type: String, enum: ['public', 'private'], default: 'public', index: true },
    /**
     * The membership tier this video is gated behind, or null for "any active
     * subscriber". Only consulted when `visibility` is `private` — a public video is
     * open to everyone and a tier on it would be a rule nothing reads.
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
    // Incremented by `recordShare`. Shares are anonymous, so unlike likes there is no
    // per-viewer document to store and no per-viewer state to render.
    shareCount: { type: Number, default: 0 },
  },
  { timestamps: true },
)

export type Video = InferSchemaType<typeof videoSchema> & { _id: mongoose.Types.ObjectId }

export const VideoModel: Model<Video> =
  (mongoose.models.video as Model<Video>) ?? mongoose.model<Video>('video', videoSchema)
