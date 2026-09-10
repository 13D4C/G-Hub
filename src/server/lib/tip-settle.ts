import { TipModel } from '@/server/db/models/tip'
import { getStripe } from '@/server/lib/stripe'

/**
 * The one write path for tips, and the mirror of `syncSubscription`: the webhook
 * hands it a session id and it re-reads that session from Stripe rather than
 * trusting the event body.
 *
 * There is no confirm-on-return counterpart the way channel subscriptions have one.
 * A subscription has to settle within the second because it unlocks premium video;
 * a tip unlocks nothing, so the webhook alone is fast enough and the second code
 * path is not worth its bugs.
 *
 * Assumes the caller has already connected to the database.
 */
export async function settleTipSession(sessionId: string): Promise<void> {
  const session = await getStripe().checkout.sessions.retrieve(sessionId)

  // Who tipped whom is stamped server-side in `startTipCheckout` and is the only
  // thing this event carries. A payment session without it belongs to some other
  // integration sharing the test account and is ignored rather than guessed at.
  const { supporterId, creatorId, videoId } = session.metadata ?? {}
  if (!supporterId || !creatorId) {
    console.warn(`Stripe session ${session.id} carries no tip metadata; ignoring.`)
    return
  }

  // `complete` sessions can still be unpaid (an async payment method that later
  // fails). Only the money actually taken counts toward a creator's total.
  if (session.payment_status !== 'paid') return

  // Upsert keyed on the session, so Stripe re-delivering the event — which it will,
  // on any 5xx — settles the same row instead of crediting the creator twice.
  await TipModel.updateOne(
    { stripeSessionId: session.id },
    {
      supporterId,
      creatorId,
      videoId: videoId || null,
      amountCents: session.amount_total ?? 0,
      currency: session.currency ?? 'usd',
    },
    { upsert: true },
  )
}
