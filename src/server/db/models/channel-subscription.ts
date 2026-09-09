import mongoose, { type InferSchemaType, type Model } from 'mongoose'

/**
 * One row per (viewer, channel) pair, holding this app's copy of the Stripe
 * subscription that pays for it.
 *
 * Stripe is the source of truth; the webhook overwrites the row wholesale from the
 * live subscription object rather than applying per-event deltas, so the row cannot
 * drift out of sync from an event arriving late or twice.
 */
const channelSubscriptionSchema = new mongoose.Schema(
  {
    subscriberId: {
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
    // The subscriber's Stripe customer, copied from `user.stripeCustomerId` at
    // checkout. Denormalized so the webhook can find this row from the event alone.
    stripeCustomerId: { type: String, required: true, index: true },
    // Empty between "checkout started" and "checkout completed".
    stripeSubscriptionId: { type: String, default: '' },
    // Stripe's own status string, stored verbatim rather than mapped to a local
    // enum: an unknown future status then reads as "not entitled" instead of
    // failing to save.
    status: { type: String, default: 'incomplete' },
    // End of the paid period, from the subscription's items (this API version keeps
    // the period on the item, not the subscription). Null before the first invoice.
    currentPeriodEnd: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    // What the viewer agreed to pay, snapshotted so a later price change on the
    // channel does not rewrite history on the subscriber's own billing view.
    priceCents: { type: Number, default: 0 },
    currency: { type: String, default: 'usd' },
  },
  { timestamps: true },
)

// A viewer has at most one subscription per channel, so both `startChannelCheckout`
// and the webhook can upsert without ever creating a second, conflicting copy.
channelSubscriptionSchema.index({ subscriberId: 1, creatorId: 1 }, { unique: true })

export type ChannelSubscription = InferSchemaType<typeof channelSubscriptionSchema> & {
  _id: mongoose.Types.ObjectId
}

export const ChannelSubscriptionModel: Model<ChannelSubscription> =
  (mongoose.models.channelsubscription as Model<ChannelSubscription>) ??
  mongoose.model<ChannelSubscription>('channelsubscription', channelSubscriptionSchema)
