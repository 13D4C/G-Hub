// Relative, `.ts`-suffixed imports for the same reason as `tip-record.ts`:
// `scripts/test-revenue-ledger.ts` loads this under plain `node
// --experimental-strip-types`, which resolves neither tsconfig paths nor
// extensionless specifiers.
import { subscriptionInvoices } from '../data/index.ts'
import { getStripe } from './stripe.ts'

/**
 * Turn one paid Stripe invoice into a row of subscription revenue. The single write
 * path for the invoice ledger.
 *
 * Takes an id rather than the event body and re-retrieves the invoice, exactly as
 * `syncSubscription` does: that makes the handler idempotent and order-independent,
 * and means a forged or stale event body cannot credit anybody.
 *
 * Assumes the caller has already connected to the database.
 *
 * @returns whether the invoice was subscription revenue worth recording.
 */
export async function recordSubscriptionInvoice(invoiceId: string): Promise<boolean> {
  const invoice = await getStripe().invoices.retrieve(invoiceId)

  // `invoice.paid` fires for zero-amount invoices too — a trial's first invoice, a
  // full-coverage coupon, a $0 proration. None of those is money, and recording them
  // would put phantom rows on a revenue chart.
  if (invoice.status !== 'paid' || (invoice.amount_paid ?? 0) <= 0) return false

  // This API version keeps the originating subscription under `parent`, not on the
  // invoice itself. No subscription details means a one-off invoice — most likely
  // from another integration sharing the Stripe account — and is not ours to record.
  const details = invoice.parent?.subscription_details
  if (!details) return false

  const stripeSubscriptionId =
    typeof details.subscription === 'string' ? details.subscription : details.subscription.id

  // Stripe snapshots the subscription's metadata onto the invoice at finalization,
  // which is the cheap path. Older invoices — finalized before the metadata existed —
  // fall back to the subscription itself, which is the same field `syncSubscription`
  // reads, so the two can never disagree about who was paid.
  let { subscriberId, creatorId, tierId, tierName } = details.metadata ?? {}
  if (!subscriberId || !creatorId) {
    const subscription = await getStripe().subscriptions.retrieve(stripeSubscriptionId)
    ;({ subscriberId, creatorId, tierId, tierName } = subscription.metadata ?? {})
  }

  // Deliberately not resolved from `invoice.customer`: one viewer is one Stripe
  // customer across every channel they subscribe to, so the customer alone cannot
  // name a creator — guessing here would credit the wrong channel's revenue.
  if (!subscriberId || !creatorId) {
    console.warn(
      `Stripe invoice ${invoice.id} carries no subscriberId/creatorId metadata; ignoring.`,
    )
    return false
  }

  // When the money actually arrived, not when this row happened to be written — a
  // webhook retried days later must not move the income into the current month.
  const paidAt = new Date((invoice.status_transitions?.paid_at ?? invoice.created) * 1000)

  // Upsert keyed on the invoice, so a replayed webhook settles the same row instead
  // of crediting the creator twice. The whole idempotency story for the ledger.
  await subscriptionInvoices.recordByInvoiceId(invoice.id, {
    subscriberId,
    creatorId,
    stripeSubscriptionId,
    tierId: tierId || null,
    tierName: tierName ?? '',
    amountPaidCents: invoice.amount_paid,
    currency: invoice.currency ?? 'usd',
    billingReason: invoice.billing_reason ?? '',
    paidAt,
    periodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : null,
    periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : null,
  })
  return true
}
