import type Stripe from 'stripe'
// Relative, `.ts`-suffixed imports: `scripts/settle-payments.ts` loads this under
// plain `node --experimental-strip-types`.
import { classifyPaidSession, type PaymentKind } from './payment-kind.ts'
import { recordTip } from './tip-record.ts'
import { recordVideoPurchase } from './video-purchase-record.ts'

/**
 * Record one paid `mode: 'payment'` Checkout session as whichever product it bought.
 *
 * The single fork between the two one-time products. Every path that settles a
 * payment — the webhook, the return from Checkout, the recovery sweep — goes through
 * here rather than deciding for itself, because the interesting failure is not "a tip
 * was missed" but "a video purchase was recorded as a tip": the viewer is charged, the
 * creator is credited a donation, and the video stays locked.
 *
 * Assumes the caller has already connected to the database.
 *
 * @returns what was recorded, or null when the session was neither of ours.
 */
export async function recordPaidSession(
  session: Stripe.Checkout.Session,
): Promise<PaymentKind | null> {
  const kind = classifyPaidSession({
    metadata: session.metadata,
    paymentStatus: session.payment_status,
  })

  if (kind === 'videoPurchase') return (await recordVideoPurchase(session)) ? kind : null
  if (kind === 'tip') return (await recordTip(session)) ? kind : null
  return null
}
