import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { CHANNEL_ERRORS } from '@/lib/channel-errors'
import { INTERACTION_ERRORS } from '@/lib/interaction-errors'
import { TIP_MAX_CENTS, TIP_MIN_CENTS } from '@/lib/tips'
import { requireUserId } from '@/server/auth/require-user'
import { UserModel } from '@/server/db/models/user'
import { VideoModel } from '@/server/db/models/video'
import { connectToDatabase } from '@/server/db/mongoose'
import { ensureCustomerId, getAppUrl, getStripe } from '@/server/lib/stripe'

/**
 * One-time tips: a viewer paying a creator directly, either from under a video or
 * from the channel page. Unlike a channel subscription this buys no access at all —
 * nothing here touches entitlement, and a tip never unlocks a premium video.
 *
 * Nothing is written when checkout starts. The tip row appears only once Stripe
 * reports the session paid; see `src/server/lib/tip-settle.ts`.
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

    const creator = await UserModel.findById(data.creatorId)
      .select('name channelName channelCurrency')
      .lean()
    if (!creator) throw new Error(CHANNEL_ERRORS.channelNotFound)

    // A video id from the browser is checked against the creator it claims to belong
    // to. Otherwise a tip could be attributed to a video from someone else's channel,
    // and the creator's own page would show a stranger's video earning them money.
    if (data.videoId) {
      const video = await VideoModel.findOne({ _id: data.videoId, uploadedBy: creator._id })
        .select('_id')
        .lean()
      if (!video) throw new Error(INTERACTION_ERRORS.videoNotFound)
    }

    const currency = creator.channelCurrency || 'usd'
    const channelName = creator.channelName || creator.name || 'Channel'
    const creatorId = String(creator._id)
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
      // server-side. `settleTipSession` reads the row back out of here.
      metadata: { supporterId, creatorId, videoId: data.videoId ?? '' },
      success_url: `${appUrl}${returnPath}&tip=success`,
      cancel_url: `${appUrl}${returnPath}&tip=cancel`,
    })

    if (!session.url) throw new Error('Stripe returned a Checkout session with no URL.')
    return { url: session.url }
  })
