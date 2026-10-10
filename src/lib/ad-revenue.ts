/**
 * What an ad impression is worth.
 *
 * No imports, on purpose: `scripts/test-revenue-series.ts` loads the modules that
 * reach this under plain `node --experimental-strip-types`, which resolves neither
 * tsconfig paths nor extensionless specifiers.
 */

/**
 * Revenue per thousand impressions, in the channel's **own** minor units.
 *
 * Expressed in the channel's currency by fiat rather than converted: there is no FX
 * anywhere in this codebase, and inventing one here would be the wrong place for it.
 *
 * This is a modelled rate, not a payout. No ad network settles money in this app, so
 * every figure derived from it is an *estimate* and must be labelled as one wherever
 * it is shown. Changing this constant re-prices all of history — see the note on
 * `models/ad-impression.ts` for when that stops being acceptable.
 */
export const AD_CPM_CENTS = 250

/** Whether ad revenue is worth showing as a real number rather than a placeholder. */
export const AD_REVENUE_IS_ESTIMATE = true
