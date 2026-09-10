import mongoose, { type InferSchemaType, type Model } from 'mongoose'

/**
 * One row per tip or channel donation — a single Stripe payment, not a subscription.
 *
 * A row exists only once Stripe says the money arrived: `settleTipSession` writes it
 * from the paid Checkout session, so there is no `status` column and an abandoned
 * checkout leaves nothing behind to clean up. Everything needed to write the row
 * travels in the session's own metadata, which means a tip is never lost to a
 * database hiccup between starting checkout and paying for it.
 */
const tipSchema = new mongoose.Schema(
  {
    supporterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: true,
      index: true,
    },
    creatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: true,
      index: true,
    },
    /**
     * The video this tip was sent from, or null for a donation made on the channel
     * page. One collection for both because the money, the settlement and the totals
     * are identical — only the button that started it differs.
     */
    videoId: { type: mongoose.Schema.Types.ObjectId, ref: 'video', default: null },
    // Unique, so a replayed or duplicated webhook upserts the same row instead of
    // counting the tip twice. This is the whole idempotency story for tips.
    stripeSessionId: { type: String, required: true, unique: true },
    // Taken from the session's `amount_total`, not from anything the browser sent.
    amountCents: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'usd', lowercase: true },
  },
  { timestamps: true },
)

export type Tip = InferSchemaType<typeof tipSchema> & { _id: mongoose.Types.ObjectId }

export const TipModel: Model<Tip> =
  (mongoose.models.tip as Model<Tip>) ?? mongoose.model<Tip>('tip', tipSchema)
