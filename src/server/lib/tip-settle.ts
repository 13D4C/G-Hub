import { getStripe } from '@/server/lib/stripe'
import { recordTip } from '@/server/lib/tip-record'

/**
 * Settle a tip from its Checkout session id, the mirror of `syncSubscription`: the
 * caller hands over an id and this re-reads the session from Stripe rather than
 * trusting an event body.
 *
 * Two callers reach it — the webhook, and `confirmTip` when the viewer lands back
 * from Checkout. Both are needed: the webhook is the only path for a viewer who
 * pays and closes the tab, and the return is the only path when no webhook is
 * being delivered at all. `recordTip` upserts on the session id, so whichever
 * arrives first records the money and the other is a no-op.
 *
 * Assumes the caller has already connected to the database.
 */
export async function settleTipSession(sessionId: string): Promise<void> {
  const session = await getStripe().checkout.sessions.retrieve(sessionId)

  if (!(await recordTip(session))) {
    console.warn(`Stripe session ${session.id} is not a paid tip; ignoring.`)
  }
}
