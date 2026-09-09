import mongoose, { type InferSchemaType, type Model } from 'mongoose'

/**
 * One row per account, holding this app's copy of a Stripe subscription.
 *
 * Stripe is the source of truth; the webhook overwrites this row wholesale from the
 * live subscription object rather than applying per-event deltas, so the row cannot
 * drift out of sync from an event arriving late or twice.
 */
const subscriptionSchema = new mongoose.Schema(
  {
    // Unique: a user has at most one plan, so the webhook can upsert without ever
    // creating a second, conflicting copy.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: true,
      unique: true,
    },
    // Created before the first checkout and reused for every later checkout and
    // billing-portal session. Indexed because the webhook only knows the customer.
    stripeCustomerId: { type: String, required: true, index: true },
    // Empty until a checkout completes — the customer exists before the plan does.
    stripeSubscriptionId: { type: String, default: '' },
    // Stripe's own status string, stored verbatim rather than mapped to a local enum:
    // an unknown future status then reads as "not entitled" instead of failing to save.
    status: { type: String, default: 'incomplete' },
    // End of the paid period, from the subscription's items (this API version keeps
    // the period on the item, not the subscription). Null before the first invoice.
    currentPeriodEnd: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
  },
  { timestamps: true },
)

export type Subscription = InferSchemaType<typeof subscriptionSchema> & {
  _id: mongoose.Types.ObjectId
}

export const SubscriptionModel: Model<Subscription> =
  (mongoose.models.subscription as Model<Subscription>) ??
  mongoose.model<Subscription>('subscription', subscriptionSchema)
