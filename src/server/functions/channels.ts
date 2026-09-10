import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { CHANNEL_ERRORS } from '@/lib/channel-errors'
import { getUserId, requireUserId } from '@/server/auth/require-user'
import { ChannelSubscriptionModel } from '@/server/db/models/channel-subscription'
import { UserModel } from '@/server/db/models/user'
import { VideoModel } from '@/server/db/models/video'
import { connectToDatabase } from '@/server/db/mongoose'
import { isEntitled } from '@/server/lib/entitlement'
import { getAppUrl, getStripe } from '@/server/lib/stripe'
import { syncSubscription } from '@/server/lib/subscription-sync'

/**
 * A creator's channel: its profile, its videos, and the paid subscription that
 * unlocks the premium ones.
 *
 * Nothing here decides entitlement on its own — checkout hands the viewer to Stripe
 * and `syncSubscription` writes the result, so a viewer who closes the tab
 * mid-payment still ends up with correct state.
 *
 * Test mode only; see `src/server/lib/stripe.ts`.
 */

/**
 * A 24-hex ObjectId — same rationale as in `interactions.ts`: a junk id must be a
 * clean rejection, not a Mongoose CastError whose text would fail the client-side
 * allowlist and collapse into a generic fallback.
 */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

const channelIdSchema = z.object({ creatorId: objectId })
const confirmSchema = z.object({ creatorId: objectId, sessionId: z.string().min(1).max(200) })

function channelPath(creatorId: string): string {
  return `/channel?id=${creatorId}`
}

export type ChannelVideo = {
  id: string
  title: string
  description: string
  durationSeconds: number
  /** True for `visibility: 'private'` — playable only by an active subscriber. */
  premium: boolean
  /** False when this viewer may not play it, which is what draws the lock. */
  unlocked: boolean
}

export type ChannelView = {
  creatorId: string
  name: string
  description: string
  /** Minor units (cents). Zero means the channel takes no subscribers. */
  priceCents: number
  currency: string
  /** True when the viewer has an active subscription, or is the creator. */
  subscribed: boolean
  /** Stripe's status verbatim, or `'none'` when this viewer has never subscribed. */
  status: string
  /** ISO-8601 UTC, like the comment DTOs — a `Date` would format differently server- and client-side. */
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  /** The viewer owns this channel, so there is nothing to sell them. */
  isOwner: boolean
  videos: Array<ChannelVideo>
}

/**
 * A channel's profile plus its videos, seen through this viewer's entitlement.
 *
 * Tolerates an anonymous caller rather than rejecting, so the page can render the
 * price and a sign-in prompt instead of an error — a paywall nobody can read is not
 * a paywall.
 */
export const getChannel = createServerFn({ method: 'GET' })
  .validator(channelIdSchema)
  .handler(async ({ data }): Promise<ChannelView> => {
    const viewerId = await getUserId()
    await connectToDatabase()

    const creator = await UserModel.findById(data.creatorId)
      .select('name channelName channelDescription subscriptionPriceCents channelCurrency')
      .lean()
    if (!creator) throw new Error(CHANNEL_ERRORS.channelNotFound)

    const isOwner = viewerId === String(creator._id)
    const sub = viewerId
      ? await ChannelSubscriptionModel.findOne({
          subscriberId: viewerId,
          creatorId: creator._id,
        }).lean()
      : null
    const subscribed = isOwner || isEntitled(sub ?? null)

    // Premium videos are listed to everyone: the point of a paywall is that a viewer
    // can see what they would be buying. Only the media `url` is withheld, and it is
    // never selected here — playback goes through `getVideoById`, which re-checks.
    const videos = await VideoModel.find({ uploadedBy: creator._id })
      .select('title description durationSeconds visibility')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()

    return {
      creatorId: String(creator._id),
      name: creator.channelName || creator.name || 'Untitled channel',
      description: creator.channelDescription ?? '',
      priceCents: creator.subscriptionPriceCents ?? 0,
      currency: creator.channelCurrency || 'usd',
      subscribed,
      status: sub?.status ?? 'none',
      currentPeriodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      isOwner,
      videos: videos.map((v) => {
        const premium = v.visibility !== 'public'
        return {
          id: String(v._id),
          title: v.title,
          description: v.description,
          durationSeconds: v.durationSeconds,
          premium,
          unlocked: !premium || subscribed,
        }
      }),
    }
  })

const channelSettingsSchema = z.object({
  channelName: z.string().trim().max(80),
  channelDescription: z.string().trim().max(500),
  /**
   * Minor units. Capped rather than open-ended so a fat-fingered price cannot bill a
   * subscriber hundreds of dollars, and floored at Stripe's minimum chargeable
   * amount — below that Checkout rejects the session with an error the viewer, not
   * the creator, would be the one to see.
   */
  subscriptionPriceCents: z.union([
    z.literal(0),
    z.number().int().min(50).max(500_000),
  ]),
})

/**
 * Update the signed-in viewer's own channel. There is no `creatorId` argument on
 * purpose: identity comes from the session, so this can only ever edit your own
 * channel and no ownership check is needed.
 *
 * Changing the price does not touch anyone's existing subscription — Stripe keeps
 * billing each subscriber the amount they agreed to, and `channelsubscription`
 * snapshots it — so a raise applies to new subscribers only.
 */
export const updateChannelSettings = createServerFn({ method: 'POST' })
  .validator(channelSettingsSchema)
  .handler(async ({ data }): Promise<{ priceCents: number }> => {
    const userId = await requireUserId()
    await connectToDatabase()

    await UserModel.updateOne({ _id: userId }, { $set: data })
    return { priceCents: data.subscriptionPriceCents }
  })

/**
 * The viewer's Stripe customer id, creating the customer on first use and caching it
 * on the account. One customer per viewer, reused across every channel they
 * subscribe to.
 *
 * Assumes the caller has already connected to the database.
 */
async function ensureCustomerId(userId: string): Promise<string> {
  const user = await UserModel.findById(userId).select('email name stripeCustomerId').lean()
  if (user?.stripeCustomerId) return user.stripeCustomerId

  const customer = await getStripe().customers.create({
    email: user?.email,
    name: user?.name || undefined,
    // Lets a human trace a customer back to an account in the Stripe dashboard.
    metadata: { userId },
  })

  // Conditional on the field still being empty, so a concurrent double submit keeps
  // whichever id landed first and leaves this one orphaned in the test account,
  // rather than repointing the account at a new customer mid-checkout.
  const claimed = await UserModel.findOneAndUpdate(
    { _id: userId, $or: [{ stripeCustomerId: '' }, { stripeCustomerId: null }] },
    { stripeCustomerId: customer.id },
    { returnDocument: 'after', projection: { stripeCustomerId: 1 } },
  ).lean()

  return claimed?.stripeCustomerId || customer.id
}

/**
 * Start a hosted Checkout for this channel's monthly subscription and return the URL
 * to send the browser to. The client redirects; nothing is charged here.
 *
 * The recurring price is built inline from the creator's row rather than referencing
 * a Price object, so a creator can name their own fee without anyone touching the
 * Stripe dashboard.
 */
export const startChannelCheckout = createServerFn({ method: 'POST' })
  .validator(channelIdSchema)
  .handler(async ({ data }): Promise<{ url: string }> => {
    const subscriberId = await requireUserId()
    await connectToDatabase()

    if (subscriberId === data.creatorId) throw new Error(CHANNEL_ERRORS.cannotSubscribeToSelf)

    const creator = await UserModel.findById(data.creatorId)
      .select('name channelName subscriptionPriceCents channelCurrency')
      .lean()
    if (!creator) throw new Error(CHANNEL_ERRORS.channelNotFound)

    const priceCents = creator.subscriptionPriceCents ?? 0
    if (priceCents <= 0) throw new Error(CHANNEL_ERRORS.notAcceptingSubscribers)

    const existing = await ChannelSubscriptionModel.findOne({
      subscriberId,
      creatorId: creator._id,
    }).lean()
    // Stripe would happily create a second, separately billed subscription.
    if (isEntitled(existing ?? null)) throw new Error(CHANNEL_ERRORS.alreadySubscribed)

    const currency = creator.channelCurrency || 'usd'
    const customerId = await ensureCustomerId(subscriberId)
    const channelName = creator.channelName || creator.name || 'Channel'
    const creatorId = String(creator._id)

    // Written before the handoff so the channel page can say "payment pending"
    // rather than nothing if the viewer comes back before Stripe does. Upsert,
    // because a previous lapsed subscription to the same channel leaves a row.
    await ChannelSubscriptionModel.findOneAndUpdate(
      { subscriberId, creatorId: creator._id },
      { stripeCustomerId: customerId, priceCents, currency },
      { upsert: true, setDefaultsOnInsert: true },
    )

    const appUrl = getAppUrl()
    const session = await getStripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: priceCents,
            recurring: { interval: 'month' },
            product_data: { name: `${channelName} — channel subscription` },
          },
        },
      ],
      // Stamped server-side onto the subscription itself, which is the only thing
      // later webhooks carry. `syncSubscription` reads the pair back out of here.
      subscription_data: { metadata: { subscriberId, creatorId } },
      success_url: `${appUrl}${channelPath(creatorId)}&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}${channelPath(creatorId)}&checkout=cancel`,
    })

    if (!session.url) throw new Error('Stripe returned a Checkout session with no URL.')
    return { url: session.url }
  })

/**
 * Settle the subscription for a viewer just back from Checkout.
 *
 * The webhook is still the durable path and this writes nothing it would not have
 * written — both funnel into `syncSubscription`, which re-reads Stripe — but the
 * webhook can land seconds later, and premium content has to be playable
 * *immediately* on return. So the return does the same sync inline rather than
 * polling for one.
 *
 * The session id comes out of the URL, so it is treated as untrusted: the session
 * must be paid and must belong to this viewer's own Stripe customer before anything
 * is written.
 */
export const confirmChannelCheckout = createServerFn({ method: 'POST' })
  .validator(confirmSchema)
  .handler(async ({ data }): Promise<{ subscribed: boolean }> => {
    const subscriberId = await requireUserId()
    await connectToDatabase()

    const user = await UserModel.findById(subscriberId).select('stripeCustomerId').lean()
    const session = await getStripe().checkout.sessions.retrieve(data.sessionId)

    const customerId =
      typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null)
    // A session id guessed at, or lifted from someone else's URL, belongs to another
    // customer and must not unlock anything here.
    if (!customerId || !user?.stripeCustomerId || customerId !== user.stripeCustomerId) {
      throw new Error(CHANNEL_ERRORS.checkoutNotComplete)
    }
    if (session.payment_status === 'unpaid') throw new Error(CHANNEL_ERRORS.checkoutNotComplete)

    const subscriptionId =
      typeof session.subscription === 'string'
        ? session.subscription
        : (session.subscription?.id ?? null)
    if (!subscriptionId) throw new Error(CHANNEL_ERRORS.checkoutNotComplete)

    await syncSubscription(subscriptionId)

    const sub = await ChannelSubscriptionModel.findOne({
      subscriberId,
      creatorId: data.creatorId,
    })
      .select('status currentPeriodEnd')
      .lean()

    return { subscribed: isEntitled(sub ?? null) }
  })

/**
 * A Stripe-hosted billing portal session, where the viewer can cancel, resume or
 * update the card behind their channel subscriptions. Whatever they change there
 * comes back as a webhook, so this app needs no cancel or update handlers of its own.
 */
export const openBillingPortal = createServerFn({ method: 'POST' })
  .validator(channelIdSchema)
  .handler(async ({ data }): Promise<{ url: string }> => {
    const subscriberId = await requireUserId()
    await connectToDatabase()

    const user = await UserModel.findById(subscriberId).select('stripeCustomerId').lean()
    if (!user?.stripeCustomerId) throw new Error(CHANNEL_ERRORS.noSubscription)

    const session = await getStripe().billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${getAppUrl()}${channelPath(data.creatorId)}`,
    })

    return { url: session.url }
  })
