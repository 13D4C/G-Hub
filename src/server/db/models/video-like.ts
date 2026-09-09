import mongoose, { type InferSchemaType, type Model } from 'mongoose'

const videoLikeSchema = new mongoose.Schema(
  {
    videoId: { type: mongoose.Schema.Types.ObjectId, ref: 'video', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
  },
  { timestamps: true },
)

// One like per viewer per video. The toggle relies on this to reject a double submit
// with E11000, and it also covers the `exists({ videoId, userId })` lookup and the
// reconciler's group-by-video scan, so no second index is needed.
//
// Must stay above `mongoose.model(...)`: indexes declared after the model is compiled
// are silently dropped.
videoLikeSchema.index({ videoId: 1, userId: 1 }, { unique: true })

export type VideoLike = InferSchemaType<typeof videoLikeSchema> & {
  _id: mongoose.Types.ObjectId
}

export const VideoLikeModel: Model<VideoLike> =
  (mongoose.models.videoLike as Model<VideoLike>) ??
  mongoose.model<VideoLike>('videoLike', videoLikeSchema)
