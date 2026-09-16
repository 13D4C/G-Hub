import type Stripe from 'stripe'
// Relative, `.ts`-suffixed import for the same reason as `entitlement.ts`:
// `scripts/settle-payments.ts` loads this under plain `node --experimental-strip-types`,
// which resolves neither tsconfig paths nor extensionless specifiers.
import { TipModel } from '../db/models/tip.ts'
import { classifyPaidSession } from './payment-kind.ts'

/**
 * Turn one paid Checkout session into a tip row. The single write path for tips —
 * the webhook, the return from Checkout and the recovery script all land here, so
 * there is exactly one place that decides what a tip row contains.
 *
 * Takes the session rather than an id because the recovery script already has the
 * object in hand from a `list`, and re-retrieving each one would be a round trip per
 * tip for no new information.
 *
 * Assumes the caller has already connected to the database.
 *
 * @returns whether the session was a tip worth recording.
 */
export async function recordTip(session: Stripe.Checkout.Session): Promise<boolean> {
  // One rule for what a paid session is, shared with `recordVideoPurchase`. This
  // subsumes the two checks that used to live here — that the session carries our
  // metadata at all, and that the money actually arrived — and adds the one that
  // matters now: a pay-per-view purchase must never be credited as a tip. Both are
  // `mode: 'payment'` sessions, so nothing else tells them apart.
  if (
    classifyPaidSession({
      metadata: session.metadata,
      paymentStatus: session.payment_status,
    }) !== 'tip'
  ) {
    return false
  }

  // Who tipped whom is stamped server-side in `startTipCheckout` and is the only
  // thing the event carries.
  const { supporterId, creatorId, videoId } = session.metadata ?? {}

  // Upsert keyed on the session, so a replayed webhook — or a return that races the
  // webhook — settles the same row instead of crediting the creator twice. This is
  // the whole idempotency story for tips.
  await TipModel.updateOne(
    { stripeSessionId: session.id },
    {
      supporterId,
      creatorId,
      videoId: videoId || null,
      // Taken from Stripe's copy of the session, never from anything a browser sent.
      amountCents: session.amount_total ?? 0,
      currency: session.currency ?? 'usd',
    },
    { upsert: true },
  )
  return true
}
