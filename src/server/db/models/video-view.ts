import mongoose, { type InferSchemaType, type Model } from 'mongoose'

/**
 * One row per (viewer, video) pair, counting how often that viewer has opened that
 * video and when they last did — the per-person half of what `video.viewCount` only
 * knows in aggregate.
 *
 * It exists for one reason: the personalized feed needs to know which channels a
 * viewer keeps coming back to, and `viewCount` cannot answer that. The schema note on
 * `viewCount` anticipated exactly this ("add a per-(viewer, video, day) collection if
 * the number ever has to mean people") — this is narrower than that, since the feed
 * wants affinity rather than a corrected view total, so `viewCount` keeps its own
 * meaning and this does not try to replace it.
 *
 * **This is a ranking signal, not a watch history the viewer can see.** The
 * distinction matters because of the TTL below: rows expire, and nothing warns
 * anybody. If this ever becomes a user-facing "recently watched" list, the TTL stops
 * being housekeeping and becomes silent data loss.
 *
 * Anonymous viewers write nothing — there is no id to key a row on, and `recordWatch`
 * returns before touching the database.
 */
const videoViewSchema = new mongoose.Schema(
  {
    viewerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: true,
    },
    videoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'video',
      required: true,
    },
    /**
     * The video's uploader, denormalized off the video so affinity per channel is a
     * group-by on this collection alone rather than a join back to `videos` — exactly
     * what `videopurchase.creatorId` is for.
     *
     * Nullable rather than required, because `video.uploadedBy` is optional: a video
     * predating channels has no creator to record, and refusing to record the watch
     * at all would be a worse answer than recording it with no channel.
     */
    creatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      default: null,
    },
    /**
     * Opens, not distinct sessions — it inherits `viewCount`'s looseness, since both
     * are incremented from the same handler. A reload counts again. The feed only
     * compares these against each other, so a consistent overcount costs nothing.
     */
    watchCount: { type: Number, default: 0 },
    lastWatchedAt: { type: Date, required: true },
  },
  { timestamps: true },
)

// Every index must stay above `mongoose.model(...)`: indexes declared after the model
// is compiled are silently dropped. Same warning as on `videolike`.

/**
 * The upsert key, and the reason a rewatch increments a row rather than adding one.
 * Unique so two concurrent first-watches cannot both insert — the loser gets an
 * E11000, which `recordWatch` swallows along with everything else.
 */
videoViewSchema.index({ viewerId: 1, videoId: 1 }, { unique: true })

/** How `loadViewerSignals` reads a viewer's recent history, newest first. */
videoViewSchema.index({ viewerId: 1, lastWatchedAt: -1 })

/**
 * Ninety days, after which a row expires on its own.
 *
 * Affinity older than a quarter is noise — it describes somebody the viewer used to
 * be — and expiring it bounds the collection without a sweeper job to run or forget.
 *
 * Must be its own single-field index: a TTL index cannot be compound, so this cannot
 * be folded into the `{ viewerId, lastWatchedAt }` one above despite the shared key.
 */
videoViewSchema.index({ lastWatchedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 })

export type VideoView = InferSchemaType<typeof videoViewSchema> & {
  _id: mongoose.Types.ObjectId
}

export const VideoViewModel: Model<VideoView> =
  (mongoose.models.videoview as Model<VideoView>) ??
  mongoose.model<VideoView>('videoview', videoViewSchema)
