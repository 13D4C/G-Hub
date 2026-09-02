import mongoose, { type InferSchemaType, type Model } from 'mongoose'

const videoSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    url: { type: String, required: true },
    durationSeconds: { type: Number, default: 0 },
  },
  { timestamps: true },
)

export type Video = InferSchemaType<typeof videoSchema> & { _id: mongoose.Types.ObjectId }

export const VideoModel: Model<Video> =
  (mongoose.models.video as Model<Video>) ?? mongoose.model<Video>('video', videoSchema)
