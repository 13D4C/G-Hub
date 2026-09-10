/**
 * Messages the channel, tipping and billing server functions reject with. Mirrors
 * `src/lib/auth-errors.ts` and `src/lib/interaction-errors.ts`: only these are
 * rendered, so a Stripe misconfiguration or API outage collapses to a generic
 * message instead of putting key names in front of a viewer.
 */
export const CHANNEL_ERRORS = {
  channelNotFound: 'That channel does not exist.',
  notAcceptingSubscribers: 'This channel has no membership tiers yet.',
  alreadySubscribed: 'You are already subscribed to this channel.',
  cannotSubscribeToSelf: 'This is your own channel.',
  noSubscription: 'You do not have a subscription to manage yet.',
  checkoutNotComplete: 'That payment has not completed.',
  cannotTipSelf: 'You cannot tip your own channel.',
  invalidTipAmount: 'Enter an amount between $0.50 and $5,000.',

  // --- Membership tiers ---
  tierNotFound: 'That membership tier no longer exists.',
  tierLimitReached: 'You have reached the maximum number of membership tiers.',
  duplicateTierName: 'You already have a tier with that name.',
  // A creator's own ladder only. Renaming, repricing or gating with someone else's
  // tier is rejected as "not found" rather than "not yours": whether another
  // creator's tier exists is not this caller's business.
  tierNotYours: 'That membership tier no longer exists.',
} as const

const USER_FACING = new Set<string>(Object.values(CHANNEL_ERRORS))

export function isUserFacingChannelError(message: string): boolean {
  return USER_FACING.has(message)
}
