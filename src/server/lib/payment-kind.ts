/**
 * What one paid `mode: 'payment'` Checkout session is for.
 *
 * Alone in a module with no imports, for the same reason as `tier-access.ts` —
 * `scripts/test-payment-kind.ts` loads it under plain `node --experimental-strip-types`,
 * which resolves neither the `@/` alias nor Stripe.
 *
 * This is the load-bearing rule of the pay-per-view feature. The app sells two things
 * through a one-time payment — a tip, which grants nothing, and a video purchase,
 * which grants playback — and Stripe tells them apart by nothing at all: both arrive
 * as `checkout.session.completed` with `mode: 'payment'`. Before pay-per-view existed
 * the webhook could treat every such session as a tip. Getting this wrong now means a
 * viewer is charged, the creator is credited a tip, and no access is granted.
 */

export type PaymentKind = 'tip' | 'videoPurchase'

/** Metadata key naming the product, stamped server-side when the session is created. */
export const PAYMENT_KIND_TIP = 'tip'
export const PAYMENT_KIND_VIDEO_PURCHASE = 'video-purchase'

/** The parts of a Checkout session this rule reads. */
export type SessionFacts = {
  metadata: Record<string, string | undefined> | null | undefined
  paymentStatus: string | null | undefined
}

/**
 * Which product this session bought, or null when it bought neither and must be left
 * alone.
 *
 * Three rules, in order:
 *
 * - Unpaid is nothing. A `complete` session can still be unpaid (an async payment
 *   method that later fails), and only money actually taken may be recorded.
 * - `kind` is the contract when it is present, and a value this app does not know is
 *   *not* guessed at: it belongs to some other integration sharing the test account.
 * - A session with no `kind` at all is a tip. Every tip created before pay-per-view
 *   existed is in that shape, and the 30-day recovery sweep still has to settle those.
 *
 * Sessions missing the ids their kind needs are rejected rather than half-recorded —
 * the fields are stamped server-side at creation, so their absence means this is not
 * our session.
 */
export function classifyPaidSession(session: SessionFacts): PaymentKind | null {
  if (session.paymentStatus !== 'paid') return null

  const metadata = session.metadata ?? {}
  const { kind, creatorId } = metadata

  if (kind === PAYMENT_KIND_VIDEO_PURCHASE) {
    return metadata.buyerId && creatorId && metadata.videoId ? 'videoPurchase' : null
  }
  // An unrecognised kind is somebody else's session, not a tip.
  if (kind && kind !== PAYMENT_KIND_TIP) return null

  return metadata.supporterId && creatorId ? 'tip' : null
}
