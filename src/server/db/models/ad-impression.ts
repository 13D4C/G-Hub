import mongoose, { type InferSchemaType, type Model } from 'mongoose'

/**
 * One row per preroll ad actually served.
 *
 * Nothing recorded that an ad had been shown before this: `ad` carries only creative
 * and serving fields, and `pickPrerollAd` chose one without leaving a trace. Ad
 * revenue on the creator dashboard is derived from these rows — impressions times a
 * CPM — so without them the category could only ever read zero.
 *
 * **There is no money field here, on purpose.** A CPM is a modelled rate with no
 * receipt behind it, unlike `tip.amountCents`, which is money Stripe actually took.
 * Storing a per-row amount would be a second copy of a number that is already
 * derivable, and the dashboard's own rule is that reporting figures are derived
 * rather than denormalized. The trade-off is real and worth knowing: changing
 * `AD_CPM_CENTS` re-prices all of history. That is acceptable only while no ad money
 * actually settles. The day a real network pays out, add `cpmCentsAtImpression` here
 * and stop deriving — a settled payout must not move when a constant changes.
 */
const adImpressionSchema = new mongoose.Schema(
  {
    adId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ad',
      required: true,
    },
    videoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'video',
      required: true,
    },
    /**
     * Who gets paid, denormalized off `video.uploadedBy` so per-channel revenue is a
     * group-by on this collection alone — the same reason `videopurchase.creatorId`
     * exists.
     *
     * Required, unlike `videoview.creatorId`, and the difference is deliberate: a
     * creatorless *ranking signal* is still useful, but a creatorless *revenue row*
     * credits nobody and would only inflate a total no one can see. `recordAdImpression`
     * skips the write instead.
     */
    creatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: true,
      index: true,
    },
    /** Null for a signed-out viewer, who is most of the audience that sees an ad. */
    viewerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      default: null,
    },
    shownAt: { type: Date, required: true },
    /**
     * `viewer:video:ad:window`, which the unique index below turns into a rate limit.
     *
     * **The field is omitted entirely for anonymous viewers, never set to `null`.** A
     * sparse unique index skips documents that lack the field, but an explicit `null`
     * *is* a value and *is* indexed — which would collapse every anonymous impression
     * in the system into a single row, forever. This is the easiest thing here to get
     * wrong, and it fails silently as a permanently frozen ad-revenue number.
     */
    dedupeKey: { type: String },
  },
  { timestamps: true },
)

// Every index must stay above `mongoose.model(...)`: indexes declared after the model
// is compiled are silently dropped. Same warning as on `videoview`.

/**
 * How the revenue aggregation counts one channel's impressions per month.
 *
 * Deliberately **no TTL index**, in direct contrast to `videoview`'s ninety-day one:
 * that collection expires rows because stale affinity is noise, but expiring these
 * would erase earnings a creator has already been shown. Do not copy the TTL over.
 */
adImpressionSchema.index({ creatorId: 1, shownAt: 1 })

/**
 * One impression per viewer, video and ad per window. Sparse so anonymous rows —
 * which carry no `dedupeKey` at all — are left out of the index rather than fighting
 * over a single null slot.
 *
 * This must exist *before the first impression is written*: a unique index cannot be
 * built over a collection that already holds duplicates, and a failed build leaves
 * dedupe quietly not working with nothing to show for it.
 */
adImpressionSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true })

export type AdImpression = InferSchemaType<typeof adImpressionSchema> & {
  _id: mongoose.Types.ObjectId
}

export const AdImpressionModel: Model<AdImpression> =
  (mongoose.models.adimpression as Model<AdImpression>) ??
  mongoose.model<AdImpression>('adimpression', adImpressionSchema)
