import mongoose, { type InferSchemaType, type Model } from 'mongoose'

/**
 * One row per permanent purchase of one video by one viewer — the pay-per-view
 * counterpart to `channelsubscription`, and the thing `requirePlayableVideo` reads to
 * open a `buyer` video.
 *
 * Kept apart from `tip` even though both are a single Stripe payment, because the two
 * rows mean opposite things. A tip grants nothing — which is why `confirmTip` can skip
 * an ownership check and why its `videoId` is optional and unconstrained — while this
 * row *is* an entitlement. One collection for both would mean the tip recovery sweep
 * could mint access, and a bug in whatever column told them apart would be a tip that
 * unlocks a video.
 *
 * Like a tip, a row exists only once Stripe says the money arrived: `recordVideoPurchase`
 * writes it from the paid Checkout session, so there is no `status` column and an
 * abandoned checkout leaves nothing behind to clean up. Everything needed to write it
 * travels in the session's own metadata, which means a purchase is never lost to a
 * database hiccup between starting checkout and paying for it.
 *
 * There is no expiry: a purchase is permanent, so the gate asks only whether the row
 * exists.
 */
const videoPurchaseSchema = new mongoose.Schema(
  {
    buyerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: true,
      index: true,
    },
    /**
     * The video's uploader, denormalized off the video so the creator dashboard can
     * sum a channel's sales without a join — exactly what `tip.creatorId` is for.
     */
    creatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: true,
      index: true,
    },
    videoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'video',
      required: true,
      index: true,
    },
    // Unique, so a replayed webhook — or a return from Checkout that races it —
    // upserts the same row instead of recording the sale twice. This is the whole
    // idempotency story for purchases, as it is for tips.
    stripeSessionId: { type: String, required: true, unique: true },
    // Taken from the session's `amount_total`, not from anything the browser sent.
    amountCents: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'usd', lowercase: true },
  },
  { timestamps: true },
)

/**
 * The gate's lookup: does this viewer own this video.
 *
 * Deliberately NOT unique. Idempotency already lives on `stripeSessionId`, and a
 * viewer who manages to pay twice — two checkouts opened before either settled — would
 * otherwise make the second webhook throw a duplicate-key error forever while Stripe
 * retries an event that can never succeed. Two rows is the benign outcome: the gate
 * asks `exists` either way, and the creator's total stays honest about money actually
 * taken. `startVideoPurchaseCheckout` refuses a second checkout up front, which is
 * where the realistic double-buy is stopped.
 */
videoPurchaseSchema.index({ buyerId: 1, videoId: 1 })

export type VideoPurchase = InferSchemaType<typeof videoPurchaseSchema> & {
  _id: mongoose.Types.ObjectId
}

export const VideoPurchaseModel: Model<VideoPurchase> =
  (mongoose.models.videopurchase as Model<VideoPurchase>) ??
  mongoose.model<VideoPurchase>('videopurchase', videoPurchaseSchema)
