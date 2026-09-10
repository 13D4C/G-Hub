import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { describeMutationError, meQueryOptions } from '@/lib/auth'
import { billingStatusQueryOptions, formatPeriodEnd } from '@/lib/billing'
import { openBillingPortal, startCheckout } from '@/server/functions/billing'

const billingSearchSchema = z.object({
  /** Set by the URLs Stripe Checkout returns to; see `RETURN_PATH` in `billing.ts`. */
  checkout: z.enum(['success', 'cancel']).optional().catch(undefined),
})

export const Route = createFileRoute('/billing')({
  validateSearch: billingSearchSchema,
  component: BillingPage,
})

/**
 * A Stripe-hosted page is always a full navigation, never a router one: the URL is on
 * checkout.stripe.com. `window.location.href` rather than `<a>` because the URL only
 * exists once the server function has created the session.
 */
function goTo(url: string) {
  window.location.href = url
}

function BillingPage() {
  const { checkout } = Route.useSearch()
  const { data: user } = useQuery(meQueryOptions)
  const { data: billing, isPending } = useQuery(billingStatusQueryOptions)

  const subscribe = useMutation({
    mutationFn: () => startCheckout(),
    onSuccess: ({ url }) => goTo(url),
  })
  const manage = useMutation({
    mutationFn: () => openBillingPortal(),
    onSuccess: ({ url }) => goTo(url),
  })

  const errorMessage = subscribe.isError
    ? describeMutationError(subscribe.error, 'Could not start checkout. Please try again.')
    : manage.isError
      ? describeMutationError(manage.error, 'Could not open the billing portal. Please try again.')
      : null

  if (!user) {
    return (
      <Card className="mx-auto w-full max-w-md">
        <CardHeader>
          <CardTitle>Go ad-free</CardTitle>
          <CardDescription>Sign in to subscribe or manage your plan.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/login" search={{ redirect: '/billing' }}>
              Sign in
            </Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="mx-auto w-full max-w-md">
      <CardHeader>
        <CardTitle>Go ad-free</CardTitle>
        <CardDescription>
          No preroll ads, and every subscriber-only video unlocked.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Checkout redirects back here before its webhook has necessarily landed, so
            "success" promises nothing about the status below — it explains why the
            plan may still read as inactive for a moment. */}
        {checkout === 'success' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Payment received. Your plan activates as soon as Stripe confirms it — reload
            in a moment if it still shows as inactive.
          </p>
        ) : null}
        {checkout === 'cancel' ? (
          <p role="status" className="text-sm text-muted-foreground">
            Checkout cancelled. Nothing was charged.
          </p>
        ) : null}

        {isPending ? (
          <p className="text-sm text-muted-foreground">Loading your plan…</p>
        ) : billing?.subscribed ? (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">
              Active{billing.status === 'trialing' ? ' (trial)' : ''}
            </p>
            {billing.currentPeriodEnd ? (
              <p className="text-muted-foreground">
                {billing.cancelAtPeriodEnd ? 'Ends' : 'Renews'} on{' '}
                {formatPeriodEnd(billing.currentPeriodEnd)}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {/* `past_due` and `unpaid` are the states worth naming: the viewer has a
                plan and a payment problem, and the portal is where they fix it. */}
            {billing?.status === 'past_due' || billing?.status === 'unpaid'
              ? 'Your last payment failed. Update your card to restore your plan.'
              : 'You are on the free plan.'}
          </p>
        )}

        {errorMessage ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {billing?.subscribed ? null : (
            <Button onClick={() => subscribe.mutate()} disabled={subscribe.isPending}>
              {subscribe.isPending ? 'Opening checkout…' : 'Subscribe'}
            </Button>
          )}
          {/* Shown whenever a Stripe customer exists — including a lapsed or past_due
              plan, which is exactly when someone needs to fix their card. */}
          {billing && billing.status !== 'none' ? (
            <Button variant="outline" onClick={() => manage.mutate()} disabled={manage.isPending}>
              {manage.isPending ? 'Opening…' : 'Manage billing'}
            </Button>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">
          Test mode. Pay with card 4242 4242 4242 4242, any future expiry and any CVC.
        </p>
      </CardContent>
    </Card>
  )
}
