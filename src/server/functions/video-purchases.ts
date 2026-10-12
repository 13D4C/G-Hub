import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { CHANNEL_ERRORS } from '@/lib/channel-errors'
import { INTERACTION_ERRORS } from '@/lib/interaction-errors'
import { isSellablePrice } from '@/lib/video-price'
import { requireUserId } from '@/server/auth/require-user'
import { users, videos } from '@/server/data'
import { hasPurchasedVideo } from '@/server/lib/entitlement'
import { PAYMENT_KIND_VIDEO_PURCHASE } from '@/server/lib/payment-kind'
import { recordPaidSession } from '@/server/lib/payment-record'
import { ensureCustomerId, getAppUrl, getStripe } from '@/server/lib/stripe'

/**
 * Pay-per-view: a viewer buying one video outright, permanently.
 *
 * The one-off payment plumbing is the tip flow's (`src/server/functions/tips.ts`), but
 * what the money buys differs in the way that matters — a tip grants nothing, and this
 * grants playback. Two consequences run through everything below:
 *
 * 1. Every figure comes from the database, never from the browser. A tip's amount is
 *    the viewer's to choose; a price is the creator's, so `priceCents` is read off the
 *    video and the request carries only which video.
 * 2. The buyer is whoever Stripe's own copy of the session says paid —
 *    `recordVideoPurchase` reads `metadata.buyerId`, never `requireUserId()`. That,
 *    rather than the ownership check in `confirmVideoPurchase`, is what stops a
 *    borrowed session id from unlocking anything: the worst it can do is settle
 *    somebody else's genuinely-paid purchase slightly early, for them.
 *
 * Nothing is written when checkout starts. The purchase row appears only once Stripe
 * reports the session paid, so an abandoned checkout leaves nothing behind — and a row
 * existing always means "watchable".
 *
 * Test mode only; see `src/server/lib/stripe.ts`.
 */

/** Same rationale as in `channels.ts`: a junk id must be a clean rejection. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

const purchaseSchema = z.object({ videoId: objectId })
const confirmSchema = z.object({
  videoId: objectId,
  sessionId: z.string().min(1).max(200),
})

/** Back to the video the viewer was trying to watch, where the player now is. */
function videoReturnUrl(videoId: string): string {
  return `${getAppUrl()}/video?id=${videoId}`
}

/**
 * Start a hosted Checkout for one pay-per-view video and return the URL to send the
 * browser to. The client redirects; nothing is charged here, and nothing is stored.
 *
 * Every guard runs before the Stripe call, so a refusal costs no session.
 */
export const startVideoPurchaseCheckout = createServerFn({ method: 'POST' })
  .validator(purchaseSchema)
  .handler(async ({ data }): Promise<{ url: string }> => {
    const buyerId = await requireUserId()
    const video = await videos.findById(data.videoId)
    if (!video) throw new Error(INTERACTION_ERRORS.videoNotFound)
    if (video.visibility !== 'buyer') throw new Error(CHANNEL_ERRORS.videoNotForSale)

    // A video with no uploader has no channel to pay, and no currency to price in.
    const creatorId = video.uploadedBy ? String(video.uploadedBy) : ''
    if (!creatorId) throw new Error(CHANNEL_ERRORS.videoNotForSale)
    if (creatorId === buyerId) throw new Error(CHANNEL_ERRORS.cannotBuyOwnVideo)

    // A price outside the bounds the write paths enforce means the video is not
    // actually on sale. Refused rather than quietly clamped: charging a figure the
    // creator did not choose is worse than refusing to charge at all.
    if (!isSellablePrice(video.priceCents)) throw new Error(CHANNEL_ERRORS.videoNotForSale)
    const priceCents = video.priceCents

    // The purchase is permanent, so a second one would be a second charge for
    // something the viewer already owns. This check is the real guard — the
    // `(buyerId, videoId)` index is deliberately not unique, for the reasons given on
    // the model — so it runs before any session is created.
    if (await hasPurchasedVideo(buyerId, video.id)) {
      throw new Error(CHANNEL_ERRORS.alreadyPurchased)
    }

    const creator = await users.findById(creatorId)
    if (!creator) throw new Error(CHANNEL_ERRORS.channelNotFound)

    const currency = creator.channelCurrency || 'usd'
    const customerId = await ensureCustomerId(buyerId)
    const videoId = video.id
    const returnUrl = videoReturnUrl(videoId)

    const session = await getStripe().checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: priceCents,
            product_data: { name: video.title },
          },
        },
      ],
      // Stamped server-side, and the only record of who bought what until the row is
      // written. `kind` is what tells this apart from a tip — both are `mode: 'payment'`
      // sessions and Stripe carries nothing else that would.
      metadata: {
        kind: PAYMENT_KIND_VIDEO_PURCHASE,
        buyerId,
        creatorId,
        videoId,
        // Audit only. The amount recorded is always Stripe's own `amount_total`.
        priceCents: String(priceCents),
      },
      // The session id travels back in the URL so the return can settle the purchase
      // itself. Without it the webhook is the *only* settlement path, and a purchase
      // whose webhook never arrives is money taken for a video that stays locked.
      success_url: `${returnUrl}&purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnUrl}&purchase=cancel`,
    })

    if (!session.url) throw new Error('Stripe returned a Checkout session with no URL.')
    return { url: session.url }
  })

/**
 * Settle the purchase for a viewer just back from Checkout.
 *
 * The webhook remains the durable path — a viewer who pays and closes the tab never
 * reaches this — but it must not be the only one: money has been taken, and the video
 * has to be playable *now* rather than whenever a webhook happens to land. Both call
 * the same idempotent `recordPaidSession`, which upserts on the session id, so
 * whichever arrives first grants the access and the second is a no-op.
 *
 * Unlike `confirmTip`, this checks that the session belongs to the caller before
 * settling it. The check is not what makes the flow safe — the row is written for
 * `metadata.buyerId` either way, so a forged id cannot grant the caller anything — but
 * `confirmTip`'s exemption is justified by "a tip grants nothing", and that sentence
 * is false here. Without the check this would report success to someone who bought
 * nothing while every gate correctly refused them, and would answer whether an
 * arbitrary session id exists. `confirmChannelCheckout` applies the same guard for the
 * same reason: it is the other path that grants access.
 */
export const confirmVideoPurchase = createServerFn({ method: 'POST' })
  .validator(confirmSchema)
  .handler(async ({ data }): Promise<{ purchased: boolean }> => {
    const buyerId = await requireUserId()
    const user = await users.findById(buyerId)
    const session = await getStripe().checkout.sessions.retrieve(data.sessionId)

    const customerId =
      typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null)
    // A session id guessed at, or lifted from someone else's URL, belongs to another
    // customer and must not be settled through this caller's request.
    if (!customerId || !user?.stripeCustomerId || customerId !== user.stripeCustomerId) {
      throw new Error(CHANNEL_ERRORS.checkoutNotComplete)
    }
    // One Stripe customer per account today, so this is belt and braces — but the two
    // checks fail independently, and this is the one that matches what gets written.
    if (session.metadata?.buyerId !== buyerId) {
      throw new Error(CHANNEL_ERRORS.checkoutNotComplete)
    }

    await recordPaidSession(session)

    return { purchased: await hasPurchasedVideo(buyerId, data.videoId) }
  })
