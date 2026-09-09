import mongoose, { type InferSchemaType, type Model } from 'mongoose'

/** Also mirrored in `src/lib/interaction-errors.ts` for the client to read. */
export const COMMENT_MAX_LENGTH = 1000

const videoCommentSchema = new mongoose.Schema(
  {
    videoId: { type: mongoose.Schema.Types.ObjectId, ref: 'video', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'user', required: true },
    body: { type: String, required: true, trim: true, maxlength: COMMENT_MAX_LENGTH },
    // Set the first time the author edits, so the DTO can distinguish "edited" from
    // "created" without comparing dates.
    editedAt: { type: Date },
  },
  { timestamps: true },
)

// Newest-first page of one video's comments. `_id` descending doubles as the keyset
// cursor, so this one index serves both the sort and the `_id < cursor` bound.
videoCommentSchema.index({ videoId: 1, _id: -1 })

export type VideoComment = InferSchemaType<typeof videoCommentSchema> & {
  _id: mongoose.Types.ObjectId
}

export const VideoCommentModel: Model<VideoComment> =
  (mongoose.models.videoComment as Model<VideoComment>) ??
  mongoose.model<VideoComment>('videoComment', videoCommentSchema)
