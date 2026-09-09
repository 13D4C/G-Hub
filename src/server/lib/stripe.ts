import Stripe from 'stripe'
import { getRequest } from '@tanstack/react-start/server'

/**
 * Stripe wiring for the billing sandbox. Mirrors `src/server/auth/google.ts`: the
 * environment is read lazily inside getters, so an app running without billing
 * configured still boots and only the billing routes fail.
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

/** The recurring price the subscribe button checks out. Created in the Stripe test dashboard. */
export function getPriceId(): string {
  const priceId = process.env.STRIPE_PRICE_ID
  if (!priceId) {
    throw new Error('STRIPE_PRICE_ID is not set. Add it to your .env file (see .env.example).')
  }
  return priceId
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
