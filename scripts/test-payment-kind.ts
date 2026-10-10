/**
 * Self-check for the rule that decides what a paid Checkout session bought.
 *
 * Run: npm run test:payment-kind
 *
 * The highest-value check in the pay-per-view feature. The app sells two things
 * through a one-time payment — a tip, which grants nothing, and a video purchase,
 * which grants playback — and Stripe delivers both as `checkout.session.completed`
 * with `mode: 'payment'`. If this rule is wrong, a viewer is charged, the creator is
 * credited a donation, and the video stays locked. The recovery sweep would then keep
 * getting it wrong for thirty days.
 *
 * `classifyPaidSession` lives alone in a module with no imports precisely so this can
 * run under plain `node --experimental-strip-types`, which resolves neither the `@/`
 * alias nor Stripe. Same arrangement as `test-entitlement.ts`.
 */
import assert from 'node:assert/strict'
import { classifyPaidSession } from '../src/server/lib/payment-kind.ts'

/** A session as the classifier sees it. Defaults to paid, since unpaid is its own case. */
function session(metadata: Record<string, string | undefined> | null, paymentStatus = 'paid') {
  return classifyPaidSession({ metadata, paymentStatus })
}

const tipMeta = { kind: 'tip', supporterId: 'u1', creatorId: 'c1', videoId: 'v1' }
const purchaseMeta = { kind: 'video-purchase', buyerId: 'u1', creatorId: 'c1', videoId: 'v1' }

// --- Unpaid is nothing at all ---
// A `complete` session can still be unpaid: an async payment method that later fails.
// Only money actually taken may be recorded, whichever product it was for.
assert.equal(session(tipMeta, 'unpaid'), null)
assert.equal(session(purchaseMeta, 'unpaid'), null)
assert.equal(session(purchaseMeta, 'no_payment_required'), null)
// Called directly rather than through the helper above, whose `= 'paid'` default
// would swallow the very absence this case is about.
assert.equal(classifyPaidSession({ metadata: purchaseMeta, paymentStatus: undefined }), null)
assert.equal(classifyPaidSession({ metadata: purchaseMeta, paymentStatus: null }), null)

// --- Tips ---
assert.equal(session(tipMeta), 'tip')
// A tip session created before pay-per-view existed carries no `kind` at all. The
// 30-day recovery sweep still has to settle those, so absent must read as a tip.
assert.equal(session({ supporterId: 'u1', creatorId: 'c1' }), 'tip')
// A channel donation: same shape, no video.
assert.equal(session({ supporterId: 'u1', creatorId: 'c1', videoId: '' }), 'tip')

// --- Video purchases ---
assert.equal(session(purchaseMeta), 'videoPurchase')
// The extra audit field rides along and changes nothing.
assert.equal(session({ ...purchaseMeta, priceCents: '499' }), 'videoPurchase')

// --- Neither ---
// No metadata: some other integration sharing the test account. Never guessed at.
assert.equal(session(null), null)
assert.equal(session({}), null)
assert.equal(session(undefined as never), null)
// An unrecognised `kind` is somebody else's product, not a tip by default.
assert.equal(session({ kind: 'merch', supporterId: 'u1', creatorId: 'c1' }), null)

// --- Incomplete metadata fails closed, rather than writing a half row ---
// Every id is stamped server-side at creation, so a missing one means this is not our
// session — not that we should invent the gap.
assert.equal(session({ kind: 'video-purchase', creatorId: 'c1', videoId: 'v1' }), null)
assert.equal(session({ kind: 'video-purchase', buyerId: 'u1', videoId: 'v1' }), null)
assert.equal(
  session({ kind: 'video-purchase', buyerId: 'u1', creatorId: 'c1' }),
  null,
  'a purchase with no video is not a purchase of anything',
)
assert.equal(session({ kind: 'tip', creatorId: 'c1' }), null)
assert.equal(session({ kind: 'tip', supporterId: 'u1' }), null)

// --- The one that matters most, stated directly ---
// A purchase must never classify as a tip, and a tip must never classify as a
// purchase. Everything above is in service of these two lines.
assert.notEqual(session(purchaseMeta), 'tip', 'a purchase must never be credited as a tip')
assert.notEqual(session(tipMeta), 'videoPurchase', 'a tip must never unlock a video')

console.log('payment kind: all checks passed')
