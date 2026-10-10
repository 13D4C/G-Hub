import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { CHANNEL_ERRORS } from '@/lib/channel-errors'
import { INTERACTION_ERRORS } from '@/lib/interaction-errors'
import { TIP_MAX_CENTS, TIP_MIN_CENTS } from '@/lib/tips'
import { requireUserId } from '@/server/auth/require-user'
import { users, videos } from '@/server/data'
import { connectToDatabase } from '@/server/db/mongoose'
import { ensureCustomerId, getAppUrl, getStripe } from '@/server/lib/stripe'
import { PAYMENT_KIND_TIP } from '@/server/lib/payment-kind'
import { settlePaidSession } from '@/server/lib/payment-settle'

/**
 * One-time tips: a viewer paying a creator directly, either from under a video or
 * from the channel page. Unlike a channel subscription this buys no access at all —
 * nothing here touches entitlement, and a tip never unlocks a premium video.
 *
 * Nothing is written when checkout starts. The tip row appears only once Stripe
 * reports the session paid; see `src/server/lib/tip-record.ts`.
 *
 * Test mode only; see `src/server/lib/stripe.ts`.
 */

/** Same rationale as in `channels.ts`: a junk id must be a clean rejection. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

const tipSchema = z.object({
  creatorId: objectId,
  /** Absent for a donation made on the channel page rather than under a video. */
  videoId: objectId.optional(),
  /**
   * Minor units. Bounds are re-checked in the handler rather than here so the
   * rejection is one of the allowlisted messages a viewer can actually read —
   * a Zod issue string would collapse to the generic fallback.
   */
  amountCents: z.number().int(),
})

/**
 * Start a hosted Checkout for a one-time tip and return the URL to send the browser
 * to. The client redirects; nothing is charged here, and nothing is stored.
 *
 * The amount comes from the viewer, so it is bounded on the way in — Stripe's floor
 * at the bottom, and a ceiling at the top so a mistyped amount is a rejection rather
 * than a very large card charge.
 */
export const startTipCheckout = createServerFn({ method: 'POST' })
  .validator(tipSchema)
  .handler(async ({ data }): Promise<{ url: string }> => {
    const supporterId = await requireUserId()
    await connectToDatabase()

    if (supporterId === data.creatorId) throw new Error(CHANNEL_ERRORS.cannotTipSelf)
    if (data.amountCents < TIP_MIN_CENTS || data.amountCents > TIP_MAX_CENTS) {
      throw new Error(CHANNEL_ERRORS.invalidTipAmount)
    }

    const creator = await users.findById(data.creatorId)
    if (!creator) throw new Error(CHANNEL_ERRORS.channelNotFound)

    // A video id from the browser is checked against the creator it claims to belong
    // to. Otherwise a tip could be attributed to a video from someone else's channel,
    // and the creator's own page would show a stranger's video earning them money.
    if (data.videoId) {
      const video = await videos.findById(data.videoId)
      if (!video || video.uploadedBy !== creator.id) {
        throw new Error(INTERACTION_ERRORS.videoNotFound)
      }
    }

    const currency = creator.channelCurrency || 'usd'
    const channelName = creator.channelName || creator.name || 'Channel'
    const creatorId = creator.id
    const customerId = await ensureCustomerId(supporterId)

    const appUrl = getAppUrl()
    // Back to the page the tip was sent from, so the viewer lands where they left.
    const returnPath = data.videoId ? `/video?id=${data.videoId}` : `/channel?id=${creatorId}`

    const session = await getStripe().checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: data.amountCents,
            product_data: { name: `Tip for ${channelName}` },
          },
        },
      ],
      // The only record of who tipped whom until the webhook lands, stamped
      // server-side. `recordTip` reads the row back out of here, and `kind` is what
      // keeps a pay-per-view purchase from being credited here as a donation.
      metadata: { kind: PAYMENT_KIND_TIP, supporterId, creatorId, videoId: data.videoId ?? '' },
      // The session id travels back in the URL so the return can settle the tip
      // itself. Without it the webhook is the *only* settlement path, and a tip
      // whose webhook never arrives is money taken that no creator is ever
      // credited for — with nothing left to recover it from.
      success_url: `${appUrl}${returnPath}&tip=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}${returnPath}&tip=cancel`,
    })

    if (!session.url) throw new Error('Stripe returned a Checkout session with no URL.')
    return { url: session.url }
  })

const confirmTipSchema = z.object({ sessionId: z.string().min(1).max(200) })

/**
 * Settle the tip for a viewer just back from Checkout.
 *
 * The webhook remains the durable path — a viewer who pays and closes the tab never
 * reaches this — but it is no longer the only one. Both call the same idempotent
 * `recordPaidSession`, which re-reads the session from Stripe and upserts on its id,
 * so whichever arrives first wins and the second is a no-op.
 *
 * The session id comes out of the URL and is treated as untrusted, but it needs no
 * ownership check the way `confirmChannelCheckout` does: this grants nothing to the
 * caller. Every field written — who tipped, who was tipped, how much — is read back
 * from Stripe's own copy of the session, so the worst a forged id can do is settle
 * some other genuinely-paid tip correctly and early.
 */
export const confirmTip = createServerFn({ method: 'POST' })
  .validator(confirmTipSchema)
  .handler(async ({ data }): Promise<void> => {
    await requireUserId()
    await connectToDatabase()
    await settlePaidSession(data.sessionId)
  })
