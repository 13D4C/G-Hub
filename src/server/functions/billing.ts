import { createServerFn } from '@tanstack/react-start'
import { BILLING_ERRORS } from '@/lib/billing-errors'
import { getUserId, requireUserId } from '@/server/auth/require-user'
import { SubscriptionModel } from '@/server/db/models/subscription'
import { UserModel } from '@/server/db/models/user'
import { connectToDatabase } from '@/server/db/mongoose'
import { isEntitled } from '@/server/lib/entitlement'
import { getAppUrl, getPriceId, getStripe } from '@/server/lib/stripe'

/**
 * Checkout and billing-portal handoffs. Neither of these decides anything about
 * entitlement — they hand the viewer to Stripe and the webhook writes the result, so
 * a viewer who closes the tab mid-payment still ends up with correct state.
 *
 * Test mode only; see `src/server/lib/stripe.ts`.
 */

/** Where Checkout and the portal send the viewer back to. */
const RETURN_PATH = '/billing'

export type BillingStatus = {
  subscribed: boolean
  /** Stripe's status verbatim, or `'none'` when this account has never subscribed. */
  status: string
  /** ISO-8601 UTC, like the comment DTOs — a `Date` would format differently server- and client-side. */
  currentPeriodEnd: string | null
  /** True when the plan is set to lapse at the end of the paid period. */
  cancelAtPeriodEnd: boolean
}

const NOT_SUBSCRIBED: BillingStatus = {
  subscribed: false,
  status: 'none',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
}

/**
 * The viewer's plan. Tolerates an anonymous caller rather than rejecting, so the
 * billing page can render a sign-in prompt instead of an error.
 */
export const getBillingStatus = createServerFn({ method: 'GET' }).handler(
  async (): Promise<BillingStatus> => {
    const userId = await getUserId()
    if (!userId) return NOT_SUBSCRIBED

    await connectToDatabase()
    const sub = await SubscriptionModel.findOne({ userId }).lean()
    if (!sub) return NOT_SUBSCRIBED

    return {
      subscribed: isEntitled(sub),
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    }
  },
)

/** Mongo's duplicate-key error, raised here by the unique index on `subscriptions.userId`. */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000
}

/**
 * The viewer's Stripe customer id, creating the customer and its local row on first
 * use. Written *before* the handoff to Stripe so the webhook can map the customer
 * back to an account without relying on metadata surviving the round trip.
 *
 * Assumes the caller has already connected to the database.
 */
async function ensureCustomerId(userId: string): Promise<string> {
  const existing = await SubscriptionModel.findOne({ userId }).select('stripeCustomerId').lean()
  if (existing) return existing.stripeCustomerId

  const user = await UserModel.findById(userId).select('email name').lean()
  const customer = await getStripe().customers.create({
    email: user?.email,
    name: user?.name || undefined,
    // Lets a human trace a customer back to an account in the Stripe dashboard.
    metadata: { userId },
  })

  try {
    await SubscriptionModel.create({ userId, stripeCustomerId: customer.id })
    return customer.id
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err
    // A double submit created a row in the gap above. That row's customer is the one
    // the webhook will match on, so use it and leave this customer orphaned in the
    // test account rather than writing a second id no event will ever reference.
    const winner = await SubscriptionModel.findOne({ userId }).select('stripeCustomerId').lean()
    return winner?.stripeCustomerId ?? customer.id
  }
}

/**
 * Start a hosted Checkout for the ad-free plan and return the URL to send the
 * browser to. The client redirects; nothing is charged here.
 */
export const startCheckout = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ url: string }> => {
    const userId = await requireUserId()
    await connectToDatabase()

    const existing = await SubscriptionModel.findOne({ userId }).lean()
    // Stripe would happily create a second, separately billed subscription.
    if (existing && isEntitled(existing)) {
      throw new Error(BILLING_ERRORS.alreadySubscribed)
    }

    const appUrl = getAppUrl()
    const session = await getStripe().checkout.sessions.create({
      mode: 'subscription',
      customer: await ensureCustomerId(userId),
      line_items: [{ price: getPriceId(), quantity: 1 }],
      success_url: `${appUrl}${RETURN_PATH}?checkout=success`,
      cancel_url: `${appUrl}${RETURN_PATH}?checkout=cancel`,
    })

    if (!session.url) throw new Error('Stripe returned a Checkout session with no URL.')
    return { url: session.url }
  },
)

/**
 * A Stripe-hosted billing portal session, where the viewer can cancel, resume or
 * update their card. Whatever they change there comes back as a webhook, so this app
 * needs no cancel or update handlers of its own.
 */
export const openBillingPortal = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ url: string }> => {
    const userId = await requireUserId()
    await connectToDatabase()

    const sub = await SubscriptionModel.findOne({ userId }).select('stripeCustomerId').lean()
    if (!sub) throw new Error(BILLING_ERRORS.noSubscription)

    const session = await getStripe().billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${getAppUrl()}${RETURN_PATH}`,
    })

    return { url: session.url }
  },
)
