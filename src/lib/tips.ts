/**
 * Shared rules for tip amounts. Lives here rather than in the server function so the
 * dialog, the Zod schema and `scripts/test-tips.ts` all clamp to the same numbers —
 * a preset the client offers that the server then rejects is the only interesting
 * bug in this feature.
 *
 * No imports, on purpose: `scripts/test-tips.ts` loads this under plain
 * `node --experimental-strip-types`, which resolves neither tsconfig paths nor
 * extensionless specifiers.
 */

/** Stripe rejects a charge below 50 cents outright. */
export const TIP_MIN_CENTS = 50
/** A ceiling so a mistyped amount is a rejection, not a $50,000 card charge. */
export const TIP_MAX_CENTS = 500_000

/** The one-tap amounts, in minor units. */
export const TIP_PRESETS_CENTS = [200, 500, 1000] as const

/**
 * A typed-in major-unit amount ("5", "4.20") as whole cents, or null when it is not
 * a payable amount.
 *
 * Rounds rather than truncates, and re-checks the rounded value against the bounds:
 * "0.499" must not round down to zero and slip through as a free tip.
 */
export function parseTipAmount(input: string): number | null {
  const trimmed = input.trim()
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(trimmed)) return null

  const cents = Math.round(Number(trimmed) * 100)
  if (!Number.isFinite(cents)) return null
  return cents >= TIP_MIN_CENTS && cents <= TIP_MAX_CENTS ? cents : null
}
