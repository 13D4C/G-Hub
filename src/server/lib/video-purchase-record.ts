import type Stripe from 'stripe'
// Relative, `.ts`-suffixed imports for the same reason as `tip-record.ts`:
// `scripts/settle-payments.ts` loads this under plain `node --experimental-strip-types`,
// which resolves neither tsconfig paths nor extensionless specifiers.
import { VideoPurchaseModel } from '../db/models/video-purchase.ts'
import { classifyPaidSession } from './payment-kind.ts'

/**
 * Turn one paid Checkout session into a purchase row. The single write path for
 * pay-per-view — the webhook, the return from Checkout and the recovery script all
 * land here, so there is exactly one place that decides what a purchase contains.
 *
 * Takes the session rather than an id because the recovery script already has the
 * object in hand from a `list`, and re-retrieving each one would be a round trip per
 * purchase for no new information.
 *
 * Assumes the caller has already connected to the database.
 *
 * @returns whether the session was a video purchase worth recording.
 */
export async function recordVideoPurchase(session: Stripe.Checkout.Session): Promise<boolean> {
  // One rule for what a paid session is, shared with `recordTip`, so no session can
  // ever be recorded as both — or as the wrong one.
  if (
    classifyPaidSession({
      metadata: session.metadata,
      paymentStatus: session.payment_status,
    }) !== 'videoPurchase'
  ) {
    return false
  }

  // Who bought what is stamped server-side in `startVideoPurchaseCheckout`. This is
  // also the whole of the access control on the settlement paths: the row is written
  // for the buyer Stripe's own copy of the session names, never for whoever happens
  // to be calling, so a session id lifted from someone else's URL grants its holder
  // nothing.
  const { buyerId, creatorId, videoId } = session.metadata ?? {}

  // Upsert keyed on the session, so a replayed webhook — or a return that races the
  // webhook — settles the same row instead of selling the video twice.
  await VideoPurchaseModel.updateOne(
    { stripeSessionId: session.id },
    {
      buyerId,
      creatorId,
      videoId,
      // Taken from Stripe's copy of the session, never from anything a browser sent.
      // `metadata.priceCents` rides along for auditing and is deliberately not read.
      amountCents: session.amount_total ?? 0,
      currency: session.currency ?? 'usd',
    },
    { upsert: true },
  )
  return true
}
