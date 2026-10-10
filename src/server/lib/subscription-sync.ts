import type Stripe from 'stripe'
import { ChannelSubscriptionModel } from '@/server/db/models/channel-subscription'
import { getStripe } from '@/server/lib/stripe'

/**
 * The one write path for channel-subscription state.
 *
 * Every webhook this app cares about — checkout completed, subscription created,
 * updated or deleted — ends here, and this re-fetches the subscription from Stripe
 * rather than trusting the event body. That makes the handler idempotent and
 * order-independent: a duplicate delivery writes the same row twice, and a late
 * `subscription.updated` overtaken by a newer one cannot resurrect stale state,
 * because both read today's truth from Stripe.
 *
 * `confirmChannelCheckout` calls it too, so a viewer returning from Checkout is
 * unlocked on the spot instead of waiting for the webhook to land.
 */

/**
 * End of the current paid period. This API version keeps the period on each
 * subscription item rather than on the subscription, so take the latest across
 * items — with one price there is exactly one, and with several the plan is paid
 * for until the last of them lapses.
 */
function currentPeriodEndOf(subscription: Stripe.Subscription): Date | null {
  const ends = subscription.items.data.map((item) => item.current_period_end).filter(Boolean)
  return ends.length ? new Date(Math.max(...ends) * 1000) : null
}

/** `customer` is a string on a plain retrieve and an object once expanded. */
function customerIdOf(subscription: Stripe.Subscription): string {
  return typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer.id
}

/**
 * Copy one Stripe subscription into this app's row for its (viewer, channel) pair.
 *
 * The pair comes from metadata that `startChannelCheckout` stamped onto the
 * subscription server-side — never from anything the browser could have supplied —
 * because the customer alone no longer identifies a row: one viewer is one Stripe
 * customer across every channel they subscribe to. A subscription without that
 * metadata belongs to some other integration sharing the test account and is
 * ignored rather than guessed at.
 *
 * That same metadata carries the membership tier bought, so a subscription whose
 * webhook lands before the viewer returns from Checkout — or instead of it — still
 * records *which* rung was paid for and not merely that something was.
 */
export async function syncSubscription(subscriptionId: string): Promise<void> {
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId)
  const { subscriberId, creatorId, tierId, tierName } = subscription.metadata ?? {}

  if (!subscriberId || !creatorId) {
    console.warn(
      `Stripe subscription ${subscription.id} carries no subscriberId/creatorId metadata; ignoring.`,
    )
    return
  }

  // Upsert, not update: the webhook can beat the return from Checkout, and either
  // one arriving first must produce the same row.
  await ChannelSubscriptionModel.findOneAndUpdate(
    { subscriberId, creatorId },
    {
      stripeCustomerId: customerIdOf(subscription),
      stripeSubscriptionId: subscription.id,
      status: subscription.status,
      currentPeriodEnd: currentPeriodEndOf(subscription),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      // Empty for a channel-level subscription, which is what every subscription was
      // before tiers existed. Stripe metadata values are strings, so `''` is how "no
      // tier" arrives and null is how it has to be stored.
      tierId: tierId || null,
      tierName: tierName ?? '',
    },
    { upsert: true, returnDocument: 'after' },
  ).lean()
}
