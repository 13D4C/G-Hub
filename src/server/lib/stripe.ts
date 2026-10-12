import Stripe from 'stripe'
import { getRequest } from '@tanstack/react-start/server'
import { users } from '@/server/data'

/**
 * Stripe wiring for channel subscriptions and tips. Mirrors `src/server/auth/google.ts`: the
 * environment is read lazily inside getters, so an app running without billing
 * configured still boots and only the billing paths fail.
 *
 * There is no STRIPE_PRICE_ID here on purpose — every channel prices itself, so
 * `startChannelCheckout` builds the recurring price inline from the creator's row
 * rather than requiring a Price object per creator in the dashboard.
 */

let client: Stripe | null = null

/**
 * The shared Stripe client, created on first use.
 *
 * A live key is rejected outright. This is a sandbox: every other guard here is
 * about correctness, but that one is about not charging a real card by accident.
 * The SDK pins its own API version, so none is passed.
 */
export function getStripe(): Stripe {
  if (client) return client

  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set. Add it to your .env file (see .env.example).',
    )
  }
  if (secretKey.startsWith('sk_live_')) {
    throw new Error('STRIPE_SECRET_KEY is a live key. This sandbox only accepts test keys.')
  }

  client = new Stripe(secretKey)
  return client
}

/** Signing secret for `/api/stripe/webhook`, printed by `stripe listen`. */
export function getWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    throw new Error(
      'STRIPE_WEBHOOK_SECRET is not set. Add it to your .env file (see .env.example).',
    )
  }
  return secret
}

/**
 * Absolute origin for the URLs Checkout sends the viewer back to. Derived from the
 * current request so local dev needs no extra config; set APP_URL when running
 * behind a proxy that rewrites the host, same as GOOGLE_REDIRECT_URI.
 */
export function getAppUrl(): string {
  return process.env.APP_URL ?? new URL(getRequest().url).origin
}

/**
 * The viewer's Stripe customer id, creating the customer on first use and caching it
 * on the account. One customer per viewer, reused across every channel they
 * subscribe to and every tip they send.
 *
 * Assumes the caller has already connected to the database.
 */
export async function ensureCustomerId(userId: string): Promise<string> {
  const user = await users.findById(userId)
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
  return users.claimStripeCustomerId(userId, customer.id)
}
