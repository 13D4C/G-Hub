import { createFileRoute } from '@tanstack/react-router'
import type Stripe from 'stripe'
import { connectToDatabase } from '@/server/db/mongoose'
import { getStripe, getWebhookSecret } from '@/server/lib/stripe'
import { syncSubscription } from '@/server/lib/subscription-sync'

/**
 * Stripe's view of a subscription, pushed to us.
 *
 * Run `stripe listen --forward-to localhost:3000/api/stripe/webhook` in development
 * and put the `whsec_...` it prints in STRIPE_WEBHOOK_SECRET.
 *
 * Only `customer.subscription.*` and `checkout.session.completed` are handled, and
 * neither is trusted for its contents — both are treated purely as a nudge to
 * re-read the subscription from Stripe (see `syncSubscription`). Invoice events are
 * deliberately not handled: a failed payment moves the subscription's status, which
 * arrives here as `customer.subscription.updated` anyway.
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

        const subscriptionId = subscriptionIdOf(event)
        // An event we do not act on still gets a 200, or Stripe retries it for days.
        if (!subscriptionId) return new Response(null, { status: 204 })

        // Thrown errors deliberately escape as a 500: Stripe retries with backoff,
        // which is exactly what a transient Mongo or Stripe API failure needs.
        await connectToDatabase()
        await syncSubscription(subscriptionId)

        return new Response(null, { status: 204 })
      },
    },
  },
})
