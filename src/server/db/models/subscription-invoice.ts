import mongoose, { type InferSchemaType, type Model } from 'mongoose'

/**
 * One row per subscription charge that Stripe actually collected.
 *
 * This is the per-charge history `channelsubscription` deliberately does not keep.
 * That collection is a *current-state mirror* — `syncSubscription` overwrites the
 * whole row on every webhook — so it can answer "is this viewer paying now?" but not
 * "what did this channel earn in March?". Revenue reporting needs the second
 * question, and no amount of reading the mirror will answer it.
 *
 * Like `tip` and `videopurchase`, a row exists only once the money arrived:
 * `recordSubscriptionInvoice` writes it from a paid invoice, so there is no `status`
 * column and a failed payment leaves nothing behind.
 */
const subscriptionInvoiceSchema = new mongoose.Schema(
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
    // Unique, so a replayed webhook upserts the same row instead of crediting the
    // creator twice. The whole idempotency story, exactly as `tip.stripeSessionId`.
    stripeInvoiceId: { type: String, required: true, unique: true },
    stripeSubscriptionId: { type: String, required: true, index: true },
    /**
     * Which rung was paid for, snapshotted from the subscription's metadata at the
     * time of the charge. A creator who renames or reprices a tier later must not
     * have their past invoices silently re-labelled.
     */
    tierId: { type: mongoose.Schema.Types.ObjectId, ref: 'membershipTier', default: null },
    tierName: { type: String, default: '' },
    /**
     * What Stripe actually collected — `amount_paid`, never `amount_due` or `total`.
     * A discounted or partly-credited invoice must report the money that arrived, not
     * the money that was asked for.
     */
    amountPaidCents: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'usd', lowercase: true },
    /** Stripe's own reason string: subscription_create, subscription_cycle, ... */
    billingReason: { type: String, default: '' },
    /**
     * When the money arrived, taken from the invoice's `status_transitions.paid_at`.
     *
     * **The revenue chart buckets on this, never on `createdAt`.** A webhook retried
     * a week late — or replayed during an incident — writes `createdAt = today` for
     * money that was collected in March, which would quietly move a creator's income
     * from one month into another.
     */
    paidAt: { type: Date, required: true },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
  },
  { timestamps: true },
)

// Every index must stay above `mongoose.model(...)`: indexes declared after the model
// is compiled are silently dropped. Same warning as on `videoview`.

/**
 * How the revenue aggregation reads one channel's charges. `paidAt` rather than
 * `createdAt` for the reason on the field above — the sort key has to be the same
 * date the `$group` buckets on, or the index does not serve the query.
 *
 * Note there is deliberately **no TTL index** here, unlike `videoview`: expiring a
 * revenue row would silently erase past earnings.
 */
subscriptionInvoiceSchema.index({ creatorId: 1, paidAt: 1 })

export type SubscriptionInvoice = InferSchemaType<typeof subscriptionInvoiceSchema> & {
  _id: mongoose.Types.ObjectId
}

export const SubscriptionInvoiceModel: Model<SubscriptionInvoice> =
  (mongoose.models.subscriptioninvoice as Model<SubscriptionInvoice>) ??
  mongoose.model<SubscriptionInvoice>('subscriptioninvoice', subscriptionInvoiceSchema)
