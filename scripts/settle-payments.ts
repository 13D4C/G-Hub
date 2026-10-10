/**
 * Reconcile the `tips`, `videopurchases` and `subscriptioninvoices` collections
 * against Stripe. The counterpart to `recount-likes`: a way back to truth when the
 * two disagree.
 *
 * A one-time payment is normally recorded twice over — once when the viewer lands
 * back from Checkout, once when the webhook arrives — but both can be missed at the
 * same time: no `stripe listen` running in development, and a viewer who closed the
 * tab at Stripe. For a tip that means the money is taken and the creator is never
 * credited; for a pay-per-view purchase it is worse, because the viewer paid for a
 * video that stays locked. This finds those and settles them.
 *
 * Subscription revenue is swept too, through the same `recordSubscriptionInvoice`.
 * A subscription charge is only ever recorded from an invoice — the
 * `channelsubscription` row is a current-state mirror with no per-charge history — so
 * a missed `invoice.paid` leaves the creator's subscription revenue reading zero
 * while their subscriber count is right.
 *
 * Idempotent, because it settles through the same writers the webhook uses: a clean
 * run reports nothing to fix, which is also how you verify the live paths are
 * keeping up.
 *
 * Run:
 *   npm run settle-payments
 */
import Stripe from 'stripe'
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import { TipModel } from '../src/server/db/models/tip.ts'
import { VideoPurchaseModel } from '../src/server/db/models/video-purchase.ts'
import { SubscriptionInvoiceModel } from '../src/server/db/models/subscription-invoice.ts'
import { recordPaidSession } from '../src/server/lib/payment-record.ts'
import { recordSubscriptionInvoice } from '../src/server/lib/subscription-invoice-record.ts'

/** How far back to look. Stripe expires an abandoned session after 24h anyway. */
const LOOKBACK_DAYS = 30

async function main() {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not set. Add it to your .env file.')

  const stripe = new Stripe(secretKey)
  await connectToDatabase()

  const since = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 24 * 60 * 60
  let scanned = 0
  const settled: Array<{ id: string; kind: string; amountCents: number; currency: string }> = []

  // `autoPagingEach` rather than one `list`, so a busy account is not silently
  // truncated at the first page and left with payments still missing.
  for await (const session of stripe.checkout.sessions.list({
    limit: 100,
    created: { gte: since },
  })) {
    // Only one-time payments land in this loop, and only paid ones are money. A
    // subscription's entitlement comes from `syncSubscription` and its revenue from
    // the invoice sweep below — neither is a Checkout session row.
    if (session.mode !== 'payment' || session.payment_status !== 'paid') continue
    scanned += 1

    // Checked against both collections, because either kind may be the one missing.
    const [tipped, bought] = await Promise.all([
      TipModel.exists({ stripeSessionId: session.id }),
      VideoPurchaseModel.exists({ stripeSessionId: session.id }),
    ])
    if (tipped || bought) continue

    // Never guesses which product this was: `recordPaidSession` reads the metadata
    // Stripe holds, so a purchase cannot be swept up as a tip.
    const kind = await recordPaidSession(session)
    if (!kind) continue

    settled.push({
      id: session.id,
      kind: kind === 'videoPurchase' ? 'sale' : 'tip',
      amountCents: session.amount_total ?? 0,
      currency: session.currency ?? 'usd',
    })
  }

  // --- subscription invoices ---
  let invoicesScanned = 0
  const settledInvoices: Array<{ id: string; amountCents: number; currency: string }> = []

  for await (const invoice of stripe.invoices.list({
    limit: 100,
    status: 'paid',
    created: { gte: since },
  })) {
    // No subscription behind it means a one-off invoice, most likely from another
    // integration sharing this Stripe account. Not ours to record.
    if (!invoice.parent?.subscription_details) continue
    // A zero-amount invoice — a trial, a full coupon, a $0 proration — is not revenue.
    if ((invoice.amount_paid ?? 0) <= 0) continue
    invoicesScanned += 1

    if (await SubscriptionInvoiceModel.exists({ stripeInvoiceId: invoice.id })) continue

    // By id rather than by the object in hand: the writer re-reads from Stripe so the
    // webhook cannot be fed a forged body, and paying one extra retrieve on the rare
    // missing invoice is cheaper than keeping two versions of this logic.
    if (!(await recordSubscriptionInvoice(invoice.id))) continue

    settledInvoices.push({
      id: invoice.id ?? '(no id)',
      amountCents: invoice.amount_paid,
      currency: invoice.currency ?? 'usd',
    })
  }

  for (const row of settledInvoices) {
    console.log(
      `settled subscription invoice ${row.id}: ${(row.amountCents / 100).toFixed(2)} ${row.currency.toUpperCase()}`,
    )
  }

  if (settled.length === 0 && settledInvoices.length === 0) {
    console.log(
      `All ${scanned} paid one-time session(s) and ${invoicesScanned} paid invoice(s) in the last ${LOOKBACK_DAYS} days are already recorded. Nothing to fix.`,
    )
    return
  }

  if (settledInvoices.length > 0) {
    console.log(
      `Settled ${settledInvoices.length} of ${invoicesScanned} paid subscription invoice(s).`,
    )
  }

  if (settled.length === 0) return

  for (const row of settled) {
    console.log(
      `settled ${row.kind} ${row.id}: ${(row.amountCents / 100).toFixed(2)} ${row.currency.toUpperCase()}`,
    )
  }
  const sales = settled.filter((row) => row.kind === 'sale').length
  console.log(
    `Settled ${settled.length} of ${scanned} paid session(s) — ${sales} sale(s), ${settled.length - sales} tip(s).`,
  )
}

await main()
process.exit(0)
