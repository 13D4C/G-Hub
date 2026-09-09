import type Stripe from 'stripe'
import { SubscriptionModel } from '@/server/db/models/subscription'
import { getStripe } from '@/server/lib/stripe'

/**
 * The one write path for subscription state.
 *
 * Every webhook this app cares about — checkout completed, subscription created,
 * updated or deleted, invoice payment failed — ends here, and this re-fetches the
 * subscription from Stripe rather than trusting the event body. That makes the
 * handler idempotent and order-independent: a duplicate delivery writes the same
 * row twice, and a late `subscription.updated` overtaken by a newer one cannot
 * resurrect stale state, because both read today's truth from Stripe.
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
 * Copy one Stripe subscription into this app's row for its owner.
 *
 * The row is matched on `stripeCustomerId`, which `startCheckout` wrote before
 * sending the viewer to Stripe — so the mapping back to a user never depends on
 * client-supplied metadata surviving the round trip. A subscription for a customer
 * this app has no row for is ignored rather than guessed at.
 */
export async function syncSubscription(subscriptionId: string): Promise<void> {
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId)

  const updated = await SubscriptionModel.findOneAndUpdate(
    { stripeCustomerId: customerIdOf(subscription) },
    {
      stripeSubscriptionId: subscription.id,
      status: subscription.status,
      currentPeriodEnd: currentPeriodEndOf(subscription),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    },
    { returnDocument: 'after' },
  ).lean()

  if (!updated) {
    // Not an error worth failing the webhook over: Stripe would retry forever on a
    // customer this app will never recognise (created in the dashboard by hand, or
    // left over from another environment sharing the same test account).
    console.warn(
      `Stripe subscription ${subscription.id} has no local row for customer ${customerIdOf(subscription)}; ignoring.`,
    )
  }
}
