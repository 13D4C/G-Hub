import { getStripe } from '@/server/lib/stripe'
import { recordPaidSession } from '@/server/lib/payment-record'

/**
 * Settle a one-time payment from its Checkout session id, the mirror of
 * `syncSubscription`: the caller hands over an id and this re-reads the session from
 * Stripe rather than trusting an event body.
 *
 * Three callers reach it — the webhook, `confirmTip`, and `confirmVideoPurchase` —
 * and all three are needed. The webhook is the only path for a viewer who pays and
 * closes the tab; the returns are the only path when no webhook is being delivered at
 * all, which for a purchase is the difference between money taken and a video that
 * never unlocks. Both record layers upsert on the session id, so whichever arrives
 * first wins and the rest are no-ops.
 *
 * One retrieve and one classification, so the webhook and the return can never
 * disagree about what a session was.
 *
 * Assumes the caller has already connected to the database.
 */
export async function settlePaidSession(sessionId: string): Promise<void> {
  const session = await getStripe().checkout.sessions.retrieve(sessionId)

  if (!(await recordPaidSession(session))) {
    console.warn(`Stripe session ${session.id} is not a paid tip or purchase; ignoring.`)
  }
}
