/**
 * Messages the billing server functions reject with. Mirrors `src/lib/auth-errors.ts`
 * and `src/lib/interaction-errors.ts`: only these are rendered, so a Stripe
 * misconfiguration or API outage collapses to a generic message instead of putting
 * key names in front of a viewer.
 */
export const BILLING_ERRORS = {
  alreadySubscribed: 'You already have an active subscription.',
  noSubscription: 'You do not have a subscription to manage yet.',
} as const

const USER_FACING = new Set<string>(Object.values(BILLING_ERRORS))

export function isUserFacingBillingError(message: string): boolean {
  return USER_FACING.has(message)
}
