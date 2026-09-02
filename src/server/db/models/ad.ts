import mongoose, { type InferSchemaType, type Model } from 'mongoose'

const adSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    // Public URL of the ad creative (mp4) in SeaweedFS.
    mediaUrl: { type: String, required: true },
    durationSeconds: { type: Number, default: 0 },
    // Where the viewer goes when they click the ad. Empty = not clickable.
    clickThroughUrl: { type: String, default: '' },
    // Viewer can skip the ad after this many seconds.
    skippableAfterSeconds: { type: Number, default: 3 },
    // Higher weight = more likely to be picked by the decisioning logic.
    weight: { type: Number, default: 1 },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
)

export type Ad = InferSchemaType<typeof adSchema> & { _id: mongoose.Types.ObjectId }

export const AdModel: Model<Ad> =
  (mongoose.models.ad as Model<Ad>) ?? mongoose.model<Ad>('ad', adSchema)
