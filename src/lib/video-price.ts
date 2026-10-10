/**
 * Shared rules for what a creator may charge for one pay-per-view video.
 *
 * Lives here rather than in the server function so the upload form, the price cell on
 * `/upload`, the Zod schemas and `scripts/test-video-price.ts` all clamp to the same
 * numbers — a price the client offers that the server then rejects is the only
 * interesting bug in this half of the feature.
 *
 * Deliberately parallel to `src/lib/tips.ts` rather than shared with it. The bounds
 * happen to coincide today (Stripe's floor, and a ceiling so a fat-fingered amount is
 * a rejection rather than a very large charge), but a tip is a gift the viewer prices
 * and this is a product the creator prices, so they are free to diverge. If you change
 * one, decide about the other rather than assuming.
 *
 * No imports, on purpose: `scripts/test-video-price.ts` loads this under plain
 * `node --experimental-strip-types`, which resolves neither tsconfig paths nor
 * extensionless specifiers.
 */

/** Stripe rejects a charge below 50 cents outright. */
export const VIDEO_PRICE_MIN_CENTS = 50
/** A ceiling so a mistyped price is a rejection, not a $50,000 card charge. */
export const VIDEO_PRICE_MAX_CENTS = 500_000

/** What the price field starts at, in minor units, so the creator sees a sane default. */
export const VIDEO_PRICE_DEFAULT_CENTS = 200

/**
 * A typed-in major-unit price ("5", "4.99") as whole cents, or null when it is not a
 * chargeable price.
 *
 * Rounds rather than truncates, and re-checks the rounded value against the bounds:
 * "0.499" must not round down to zero and slip through as a free pay-per-view video.
 */
export function parseVideoPrice(input: string): number | null {
  const trimmed = input.trim()
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(trimmed)) return null

  const cents = Math.round(Number(trimmed) * 100)
  if (!Number.isFinite(cents)) return null
  return cents >= VIDEO_PRICE_MIN_CENTS && cents <= VIDEO_PRICE_MAX_CENTS ? cents : null
}

/** Whether a stored price is one this video can actually be sold at. */
export function isSellablePrice(priceCents: number | null | undefined): priceCents is number {
  return (
    typeof priceCents === 'number' &&
    priceCents >= VIDEO_PRICE_MIN_CENTS &&
    priceCents <= VIDEO_PRICE_MAX_CENTS
  )
}
