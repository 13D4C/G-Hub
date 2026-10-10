import { createFileRoute } from '@tanstack/react-router'
import type Stripe from 'stripe'
import { connectToDatabase } from '@/server/db/mongoose'
import { settlePaidSession } from '@/server/lib/payment-settle'
import { recordSubscriptionInvoice } from '@/server/lib/subscription-invoice-record'
import { getStripe, getWebhookSecret } from '@/server/lib/stripe'
import { syncSubscription } from '@/server/lib/subscription-sync'

/**
 * Stripe's view of a channel subscription, a tip or a video purchase, pushed to us.
 *
 * Run `stripe listen --forward-to localhost:3000/api/stripe/webhook` in development
 * and put the `whsec_...` it prints in STRIPE_WEBHOOK_SECRET.
 *
 * Only `customer.subscription.*` and `checkout.session.completed` are handled, and
 * neither is trusted for its contents — both are treated purely as a nudge to
 * re-read the object from Stripe (see `syncSubscription` and `settlePaidSession`).
 * `invoice.paid` is handled too, but only to record revenue: it is the one event
 * that says a subscription charge was actually collected, which the subscription
 * object cannot answer because `syncSubscription` overwrites it wholesale. A *failed*
 * payment is still not handled here — it moves the subscription's status, which
 * arrives as `customer.subscription.updated` anyway.
 *
 * `checkout.session.completed` covers all three products, split first on the
 * session's `mode`: `subscription` is a channel subscription, and `payment` is a
 * one-time tip *or* a pay-per-view purchase. Nothing in the event distinguishes those
 * last two — `classifyPaidSession` does it, from metadata stamped when the session was
 * created. Do not reintroduce a branch here that assumes `payment` means tip: that is
 * how a purchase becomes a donation and the video stays locked.
 *
 * This is the durable path. `confirmChannelCheckout` runs the same sync when the
 * viewer lands back from Checkout so the unlock is immediate, but a viewer who never
 * comes back — and every later renewal, cancellation and failed payment — arrives
 * only here.
 */

/** The subscription an event concerns, or null when it concerns none. */
function subscriptionIdOf(event: Stripe.Event): string | null {
  switch (event.type) {
    case 'checkout.session.completed': {
      const { subscription } = event.data.object
      return typeof subscription === 'string' ? subscription : (subscription?.id ?? null)
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      return event.data.object.id
    default:
      return null
  }
}

export const Route = createFileRoute('/api/stripe/webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const signature = request.headers.get('stripe-signature')
        if (!signature) return new Response('Missing stripe-signature', { status: 400 })

        // The raw body, byte for byte: the signature covers the exact bytes Stripe
        // sent, so parsing before verifying would break it.
        const payload = await request.text()

        let event: Stripe.Event
        try {
          event = await getStripe().webhooks.constructEventAsync(
            payload,
            signature,
            getWebhookSecret(),
          )
        } catch (err) {
          // A bad signature is either a misconfigured secret or a forgery. Either way
          // the details belong in the logs, and Stripe must not retry — 400, not 500.
          console.error('Stripe webhook signature verification failed:', err)
          return new Response('Invalid signature', { status: 400 })
        }

        // Thrown errors below deliberately escape as a 500: Stripe retries with
        // backoff, which is exactly what a transient Mongo or Stripe failure needs.

        // A tip or a video purchase. `settlePaidSession` re-reads the session and
        // works out which; the id is all that is taken from the event.
        if (event.type === 'checkout.session.completed' && event.data.object.mode === 'payment') {
          await connectToDatabase()
          await settlePaidSession(event.data.object.id)
          return new Response(null, { status: 204 })
        }

        // A subscription charge that actually settled. This must come before
        // `subscriptionIdOf`, which returns null for invoice events — the event would
        // otherwise fall through and 204 out silently, recording nothing.
        //
        // `syncSubscription` is deliberately not called here: the renewal also emits
        // `customer.subscription.updated`, which the fallthrough below already handles
        // and which is where `currentPeriodEnd` is refreshed.
        if (event.type === 'invoice.paid') {
          await connectToDatabase()
          await recordSubscriptionInvoice(event.data.object.id)
          return new Response(null, { status: 204 })
        }

        const subscriptionId = subscriptionIdOf(event)
        // An event we do not act on still gets a 200, or Stripe retries it for days.
        if (!subscriptionId) return new Response(null, { status: 204 })

        await connectToDatabase()
        await syncSubscription(subscriptionId)

        return new Response(null, { status: 204 })
      },
    },
  },
})
