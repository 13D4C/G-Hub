/**
 * Reconcile the `tips` and `videopurchases` collections against Stripe. The
 * counterpart to `recount-likes`: a way back to truth when the two disagree.
 *
 * A one-time payment is normally recorded twice over — once when the viewer lands
 * back from Checkout, once when the webhook arrives — but both can be missed at the
 * same time: no `stripe listen` running in development, and a viewer who closed the
 * tab at Stripe. For a tip that means the money is taken and the creator is never
 * credited; for a pay-per-view purchase it is worse, because the viewer paid for a
 * video that stays locked. This finds those and settles them.
 *
 * Idempotent, because it settles through the same `recordPaidSession` the webhook
 * uses: a clean run reports nothing to fix, which is also how you verify the live
 * paths are keeping up.
 *
 * Run:
 *   npm run settle-payments
 */
import Stripe from 'stripe'
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import { TipModel } from '../src/server/db/models/tip.ts'
import { VideoPurchaseModel } from '../src/server/db/models/video-purchase.ts'
import { recordPaidSession } from '../src/server/lib/payment-record.ts'

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
    // Subscriptions settle through `syncSubscription`; only one-time payments land
    // here, and only paid ones are money.
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

  if (settled.length === 0) {
    console.log(
      `All ${scanned} paid one-time session(s) in the last ${LOOKBACK_DAYS} days are already recorded. Nothing to fix.`,
    )
    return
  }

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
