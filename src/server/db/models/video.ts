import mongoose, { type InferSchemaType, type Model } from 'mongoose'

const videoSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    url: { type: String, required: true },
    durationSeconds: { type: Number, default: 0 },
    // Only `public` videos are playable without a subscription.
    visibility: { type: String, enum: ['public', 'private'], default: 'public', index: true },
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
