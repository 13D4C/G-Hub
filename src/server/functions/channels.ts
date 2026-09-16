import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { CHANNEL_ERRORS } from '@/lib/channel-errors'
import type { VideoVisibility } from '@/lib/video-visibility'
import { getUserId, requireUserId } from '@/server/auth/require-user'
import { ChannelSubscriptionModel } from '@/server/db/models/channel-subscription'
import { MembershipTierModel } from '@/server/db/models/membership-tier'
import { UserModel } from '@/server/db/models/user'
import { TipModel } from '@/server/db/models/tip'
import { VideoModel } from '@/server/db/models/video'
import { connectToDatabase } from '@/server/db/mongoose'
import { readLadder, type MembershipTierView } from '@/server/lib/tier-ladder'
import {
  isEntitled,
  loadPurchasedVideoIds,
  loadTierRanks,
  tierRefOf,
  tierStanding,
} from '@/server/lib/entitlement'
import { isUnlocked } from '@/server/lib/video-unlock'
import { ensureCustomerId, getAppUrl, getStripe } from '@/server/lib/stripe'
import { syncSubscription } from '@/server/lib/subscription-sync'

/**
 * A creator's channel: its profile, its videos, and the membership tiers that unlock
 * the subscriber-only ones.
 *
 * A channel sells tiers and nothing else. It used to also carry a single flat price
 * of its own, which meant two systems could sell access to the same videos and
 * disagree about what a subscriber had bought — so every price now lives on a
 * `membershiptier`, and this module only ever quotes one.
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
/**
 * Which rung of the channel's ladder to buy. Required: a tier is the only thing a
 * channel sells, so there is no longer an "unspecified" purchase to fall back to.
 */
const checkoutSchema = z.object({ creatorId: objectId, tierId: objectId })
const confirmSchema = z.object({ creatorId: objectId, sessionId: z.string().min(1).max(200) })

function channelPath(creatorId: string): string {
  return `/channel?id=${creatorId}`
}

export type ChannelVideo = {
  id: string
  title: string
  description: string
  url: string
  durationSeconds: number
  visibility: VideoVisibility
  /** True for `visibility: 'subscriber'` — playable only by an active subscriber. */
  premium: boolean
  /** True for `visibility: 'buyer'` — playable only by whoever bought this one video. */
  payPerView: boolean
  /** False when this viewer may not play it, which is what draws the lock. */
  unlocked: boolean
  /** The tier this video is gated behind, or null for "any active subscriber". */
  requiredTierId: string | null
  /** That tier's name, so a locked row can say what would open it. Empty when ungated. */
  requiredTierName: string
  /** What buying it costs, so a locked row can quote a price. Null unless `payPerView`. */
  priceCents: number | null
}

export type ChannelView = {
  creatorId: string
  name: string
  description: string
  avatarUrl: string
  /** The currency every tier on this channel is priced in. */
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
  /**
   * The channel's membership ladder, lowest rung first. Empty means the channel is
   * not selling anything yet — it is the only thing a channel can sell.
   */
  tiers: Array<MembershipTierView>
  /**
   * The rung this viewer is actually entitled through — never merely the one they
   * started paying for.
   *
   * `startChannelCheckout` writes the subscription row *before* handing off to
   * Stripe, so a row naming a tier proves only that a checkout was opened. Reading
   * that as "on this tier" is how an abandoned checkout came to render as a live
   * membership, so the distinction is drawn here rather than left to each caller.
   */
  viewerTierId: string | null
  /** Its name as it read at checkout, for the "Subscribed" line. */
  viewerTierName: string
  /**
   * A rung whose checkout was started but never paid for, so the viewer is *not*
   * entitled through it. The card offers to try again.
   */
  pendingTierId: string | null
  /** Everything this channel has ever been tipped, in minor units of `currency`. */
  tipTotalCents: number
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
      .select('name channelName channelDescription channelCurrency avatarUrl')
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
    // The owner sees their own private videos here; nobody else learns they exist.
    // Applied in the query rather than by filtering the result, so a private title
    // never leaves the database on someone else's request.
    const [tiers, videos] = await Promise.all([
      readLadder(creator._id),
      VideoModel.find({
        uploadedBy: creator._id,
        ...(isOwner ? {} : { visibility: { $ne: 'private' } }),
      })
        .select('title description durationSeconds visibility requiredTierId priceCents url')
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ])

    // The row's tier says what was *attempted*; only an entitling status says what
    // was bought. `tierStanding` owns that split so this cannot drift from
    // `getChannelAccess`, which likewise reports no tier when the row does not
    // entitle.
    const rowTierId = sub?.tierId ? String(sub.tierId) : null
    const {
      entitled: entitledByRow,
      heldTierId: viewerTierId,
      pendingTierId,
    } = tierStanding(sub ? { ...sub, tierId: rowTierId } : null)

    // Ranks for every tier this page compares against, in one query. The ladder is
    // already loaded, but a video can be gated behind an *archived* tier and a
    // viewer can hold one, and neither appears in `tiers`.
    const ranks = await loadTierRanks([
      rowTierId,
      ...tiers.map((t) => t.id),
      ...videos.map((v) => v.requiredTierId),
    ])
    const tierNameById = new Map(tiers.map((t) => [t.id, t.name]))
    const heldTier = tierRefOf(viewerTierId, ranks)

    // One query for every pay-per-view row on the page, the same shape `ranks` uses.
    // A purchase is per video and owes nothing to the subscription above.
    const purchasedIds = await loadPurchasedVideoIds(
      viewerId,
      videos.filter((v) => v.visibility === 'buyer').map((v) => v._id),
    )

    // Every tip row is money that actually arrived — see `models/tip.ts` — so this
    // sums the collection with no status filter.
    const [tips] = await TipModel.aggregate<{ total: number }>([
      { $match: { creatorId: creator._id } },
      { $group: { _id: null, total: { $sum: '$amountCents' } } },
    ])

    return {
      creatorId: String(creator._id),
      name: creator.channelName || creator.name || 'Untitled channel',
      description: creator.channelDescription ?? '',
      avatarUrl: creator.avatarUrl || '',
      currency: creator.channelCurrency || 'usd',
      subscribed,
      status: sub?.status ?? 'none',
      currentPeriodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      isOwner,
      tiers,
      viewerTierId,
      viewerTierName: entitledByRow ? (sub?.tierName ?? '') : '',
      pendingTierId,
      tipTotalCents: tips?.total ?? 0,
      videos: videos.map((v) => {
        const visibility = v.visibility as VideoVisibility
        const premium = visibility === 'subscriber'
        const payPerView = visibility === 'buyer'
        const requiredTierId = v.requiredTierId ? String(v.requiredTierId) : null
        // The shared catalogue rule, which `listVideos` also runs and
        // `scripts/test-video-unlock.ts` checks without a database. This used to be a
        // second hand-maintained copy of it, spelled differently enough that checking
        // the two agreed meant reading both.
        const unlocked = isUnlocked({
          visibility,
          isOwner,
          subscribed,
          heldTier,
          requiredTier: tierRefOf(requiredTierId, ranks),
          purchased: purchasedIds.has(String(v._id)),
        })

        return {
          id: String(v._id),
          title: v.title,
          description: v.description,
          url: unlocked ? v.url : '',
          durationSeconds: v.durationSeconds,
          visibility,
          premium,
          payPerView,
          unlocked,
          requiredTierId,
          priceCents: payPerView ? (v.priceCents ?? null) : null,
          // Archived tiers are gone from the ladder but their gates still stand;
          // naming one is better than an unexplained lock, so fall back to the
          // subscription's own snapshot of the name where we have it.
          requiredTierName: requiredTierId
            ? (tierNameById.get(requiredTierId) ??
              (requiredTierId === rowTierId ? (sub?.tierName ?? '') : ''))
            : '',
        }
      }),
    }
  })

const channelSettingsSchema = z.object({
  channelName: z.string().trim().max(80),
  channelDescription: z.string().trim().max(500),
})

/**
 * Update the signed-in viewer's own channel profile. There is no `creatorId`
 * argument on purpose: identity comes from the session, so this can only ever edit
 * your own channel and no ownership check is needed.
 *
 * Deliberately carries no price. Pricing is what a membership tier is for, and a
 * second place to set one is how a channel ends up quoting two different figures
 * for the same access — see `createMembershipTier`.
 */
export const updateChannelSettings = createServerFn({ method: 'POST' })
  .validator(channelSettingsSchema)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const userId = await requireUserId()
    await connectToDatabase()

    await UserModel.updateOne({ _id: userId }, { $set: data })
    return { ok: true }
  })

/**
 * Start a hosted Checkout for one of this channel's monthly subscriptions and return
 * the URL to send the browser to. The client redirects; nothing is charged here.
 *
 * `tierId` picks a rung of the creator's membership ladder, which is the only thing
 * a channel sells. The recurring price is built inline from that tier rather than
 * referencing a Price object, so a creator can name their own fees without anyone
 * touching the Stripe dashboard.
 *
 * There is deliberately no upgrade path here: a viewer who is already entitled is
 * turned away rather than sold a second subscription, because the unique
 * `(subscriberId, creatorId)` row can hold only one while Stripe would bill both.
 * Moving between tiers means cancelling in the billing portal first, and the channel
 * page says so.
 */
export const startChannelCheckout = createServerFn({ method: 'POST' })
  .validator(checkoutSchema)
  .handler(async ({ data }): Promise<{ url: string }> => {
    const subscriberId = await requireUserId()
    await connectToDatabase()

    if (subscriberId === data.creatorId) throw new Error(CHANNEL_ERRORS.cannotSubscribeToSelf)

    const creator = await UserModel.findById(data.creatorId)
      .select('name channelName channelCurrency')
      .lean()
    if (!creator) throw new Error(CHANNEL_ERRORS.channelNotFound)

    // The tier must belong to *this* creator and still be on sale. Otherwise a
    // hand-edited request could buy a cheap tier from one channel and have it
    // recorded against another, which the gate would then honour.
    const tier = await MembershipTierModel.findOne({
      _id: data.tierId,
      creatorId: creator._id,
      active: true,
    }).lean()
    if (!tier) throw new Error(CHANNEL_ERRORS.tierNotFound)

    const priceCents = tier.priceCents

    const existing = await ChannelSubscriptionModel.findOne({
      subscriberId,
      creatorId: creator._id,
    }).lean()
    // Stripe would happily create a second, separately billed subscription.
    if (isEntitled(existing ?? null)) throw new Error(CHANNEL_ERRORS.alreadySubscribed)

    const currency = tier.currency || creator.channelCurrency || 'usd'
    const customerId = await ensureCustomerId(subscriberId)
    const channelName = creator.channelName || creator.name || 'Channel'
    const creatorId = String(creator._id)
    const tierId = String(tier._id)
    const tierName = tier.name

    // Written before the handoff so the channel page can say "payment pending"
    // rather than nothing if the viewer comes back before Stripe does. Upsert,
    // because a previous lapsed subscription to the same channel leaves a row.
    //
    // The tier is written here as well as in `syncSubscription`, and overwrites
    // whatever the row named before: a lapsed row left over from an earlier tier
    // would otherwise go on naming that one while the new payment settles.
    await ChannelSubscriptionModel.findOneAndUpdate(
      { subscriberId, creatorId: creator._id },
      { stripeCustomerId: customerId, priceCents, currency, tierId: tier._id, tierName },
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
            product_data: { name: `${channelName} — ${tier.name}` },
          },
        },
      ],
      // Stamped server-side onto the subscription itself, which is the only thing
      // later webhooks carry. `syncSubscription` reads all of it back out of here,
      // so a webhook arriving without the viewer ever returning still records which
      // tier was bought.
      subscription_data: { metadata: { subscriberId, creatorId, tierId, tierName } },
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
