/**
 * Reconcile the `tips` collection against Stripe. The counterpart to
 * `recount-likes`: a way back to truth when the two disagree.
 *
 * A tip is normally recorded twice over — once when the viewer lands back from
 * Checkout, once when the webhook arrives — but both can be missed at the same
 * time: no `stripe listen` running in development, and a viewer who closed the tab
 * at Stripe. The money is taken and the creator is never credited, with nothing in
 * the database to show it happened. This finds those and settles them.
 *
 * Idempotent, because it settles through the same `recordTip` upsert the webhook
 * uses: a clean run reports nothing to fix, which is also how you verify the live
 * paths are keeping up.
 *
 * Run:
 *   npm run settle-tips
 */
import Stripe from 'stripe'
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import { TipModel } from '../src/server/db/models/tip.ts'
import { recordTip } from '../src/server/lib/tip-record.ts'

/** How far back to look. Stripe expires an abandoned session after 24h anyway. */
const LOOKBACK_DAYS = 30

async function main() {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not set. Add it to your .env file.')

  const stripe = new Stripe(secretKey)
  await connectToDatabase()

  const since = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 24 * 60 * 60
  let scanned = 0
  const settled: Array<{ id: string; amountCents: number; currency: string }> = []

  // `autoPagingEach` rather than one `list`, so a busy account is not silently
  // truncated at the first page and left with tips still missing.
  for await (const session of stripe.checkout.sessions.list({
    limit: 100,
    created: { gte: since },
  })) {
    // Subscriptions settle through `syncSubscription`; only one-time payments are
    // tips, and only paid ones are money.
    if (session.mode !== 'payment' || session.payment_status !== 'paid') continue
    scanned += 1

    if (await TipModel.exists({ stripeSessionId: session.id })) continue
    if (!(await recordTip(session))) continue

    settled.push({
      id: session.id,
      amountCents: session.amount_total ?? 0,
      currency: session.currency ?? 'usd',
    })
  }

  if (settled.length === 0) {
    console.log(`All ${scanned} paid tip session(s) in the last ${LOOKBACK_DAYS} days are already recorded. Nothing to fix.`)
    return
  }

  for (const tip of settled) {
    console.log(`settled ${tip.id}: ${(tip.amountCents / 100).toFixed(2)} ${tip.currency.toUpperCase()}`)
  }
  console.log(`Settled ${settled.length} of ${scanned} paid tip session(s).`)
}

await main()
process.exit(0)
