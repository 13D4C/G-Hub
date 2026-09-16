/**
 * Self-check for what a creator may charge for one pay-per-view video.
 *
 * Run: npm run test:video-price
 *
 * The upload form, the price cell on `/upload`, the `updateVideoAccess` schema and
 * `startVideoPurchaseCheckout` all clamp to these two functions. A price the form
 * offers that checkout then refuses is the only interesting bug in this half of the
 * feature — the creator would have a video nobody can buy and no message saying why.
 *
 * `src/lib/video-price.ts` has no imports precisely so this can run under plain
 * `node --experimental-strip-types`. Same arrangement as `test-tips.ts`.
 */
import assert from 'node:assert/strict'
import {
  VIDEO_PRICE_MAX_CENTS,
  VIDEO_PRICE_MIN_CENTS,
  isSellablePrice,
  parseVideoPrice,
} from '../src/lib/video-price.ts'

// --- Parsing what a creator types ---
assert.equal(parseVideoPrice('5'), 500)
assert.equal(parseVideoPrice('4.99'), 499)
assert.equal(parseVideoPrice('0.50'), 50)
assert.equal(parseVideoPrice(' 2.00 '), 200, 'surrounding whitespace is not a typo worth rejecting')

// Rounds rather than truncates, and re-checks the *rounded* value against the floor:
// "0.499" must not round down to zero and slip through as a free pay-per-view video.
assert.equal(parseVideoPrice('0.499'), null)
assert.equal(parseVideoPrice('0.49'), null)

// --- Not a price ---
assert.equal(parseVideoPrice(''), null)
assert.equal(parseVideoPrice('free'), null)
assert.equal(parseVideoPrice('-5'), null, 'a negative price would be a refund, not a sale')
assert.equal(parseVideoPrice('1e3'), null, 'exponent notation is a paste accident, not an offer')
assert.equal(parseVideoPrice('4.999'), null, 'no currency here has three decimal places')
assert.equal(parseVideoPrice('0'), null, 'a free video is `public`, not a zero-priced sale')

// --- Bounds ---
assert.equal(parseVideoPrice((VIDEO_PRICE_MIN_CENTS / 100).toFixed(2)), VIDEO_PRICE_MIN_CENTS)
assert.equal(parseVideoPrice((VIDEO_PRICE_MAX_CENTS / 100).toFixed(2)), VIDEO_PRICE_MAX_CENTS)
assert.equal(
  parseVideoPrice(((VIDEO_PRICE_MAX_CENTS + 100) / 100).toFixed(2)),
  null,
  'a fat-fingered price is a rejection, not a very large charge',
)

// --- The stored-value guard the checkout uses ---
// `isSellablePrice` answers the other half: not "is this typing valid" but "is the
// figure already on this video one it can actually be sold at". Both null (never
// priced) and a nonsense figure mean the same thing at the till — not for sale.
assert.equal(isSellablePrice(499), true)
assert.equal(isSellablePrice(VIDEO_PRICE_MIN_CENTS), true)
assert.equal(isSellablePrice(VIDEO_PRICE_MAX_CENTS), true)
assert.equal(isSellablePrice(null), false)
assert.equal(isSellablePrice(undefined), false, '`.lean()` skips defaults, so undefined is real')
assert.equal(isSellablePrice(0), false)
assert.equal(isSellablePrice(49), false)
assert.equal(isSellablePrice(VIDEO_PRICE_MAX_CENTS + 1), false)

// The two agree on every figure the parser accepts, which is what keeps the form from
// offering a price checkout would then refuse.
for (const typed of ['0.50', '1', '4.99', '250', '5000']) {
  const cents = parseVideoPrice(typed)
  assert.notEqual(cents, null, `${typed} should parse`)
  assert.equal(isSellablePrice(cents), true, `${typed} parses but would not sell`)
}

console.log('video price: all checks passed')
