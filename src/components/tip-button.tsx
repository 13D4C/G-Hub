import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { HandCoins } from 'lucide-react'
import { SignInPrompt } from '@/components/sign-in-prompt'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { describeMutationError, meQueryOptions } from '@/lib/auth'
import { formatPrice } from '@/lib/channels'
import { TIP_MAX_CENTS, TIP_MIN_CENTS, TIP_PRESETS_CENTS, parseTipAmount } from '@/lib/tips'
import { startTipCheckout } from '@/server/functions/tips'

/**
 * Send a creator a one-time tip. The same control on both entry points: under a
 * video, where `videoId` attributes the tip to what the viewer was watching, and on
 * the channel page, where it is a plain donation.
 *
 * A tip buys nothing — no premium unlock, no subscription — so there is nothing to
 * refresh when the viewer comes back. The channel page's total updates on its next
 * load, once the webhook has settled the payment.
 */
export function TipButton({
  creatorId,
  creatorName,
  currency,
  videoId,
  redirect,
  className,
}: {
  creatorId: string
  creatorName: string
  currency: string
  /** Omitted on the channel page: a donation to the channel, not to one video. */
  videoId?: string
  /** Where to send a signed-out viewer back to after they sign in. */
  redirect: string
  className?: string
}) {
  const { data: viewer } = useQuery(meQueryOptions)
  const [open, setOpen] = useState(false)
  // Held as a major-unit string so the field behaves like a price, exactly as the
  // channel's own price field does. `parseTipAmount` is the only thing that reads it.
  const [amount, setAmount] = useState(() => (TIP_PRESETS_CENTS[1] / 100).toFixed(2))

  const tip = useMutation({
    mutationFn: (amountCents: number) =>
      startTipCheckout({ data: { creatorId, videoId, amountCents } }),
    // A full page assignment, not a router navigation: Checkout is Stripe's origin.
    onSuccess: (result) => {
      window.location.href = result.url
    },
  })

  if (!viewer) return <SignInPrompt redirect={redirect} label="Sign in to tip" />
  // Nobody tips themselves, and the server rejects it anyway.
  if (viewer.id === creatorId) return null

  const amountCents = parseTipAmount(amount)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className={className}>
          <HandCoins />
          Tip
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tip {creatorName}</DialogTitle>
          <DialogDescription>
            A one-time thank-you. It does not unlock premium videos — that is what a
            channel subscription is for.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (amountCents) tip.mutate(amountCents)
          }}
        >
          <div className="flex flex-wrap gap-2">
            {TIP_PRESETS_CENTS.map((preset) => (
              <Button
                key={preset}
                type="button"
                size="sm"
                variant={amountCents === preset ? 'default' : 'outline'}
                aria-pressed={amountCents === preset}
                onClick={() => setAmount((preset / 100).toFixed(2))}
              >
                {formatPrice(preset, currency)}
              </Button>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tip-amount">Amount</Label>
            <Input
              id="tip-amount"
              // `inputMode` rather than `type="number"`, whose spinners and locale
              // handling fight a currency field.
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            {/* Only once the viewer has typed something unusable — an empty field on
                open is not an error yet. */}
            {amount.trim() && !amountCents ? (
              <p className="text-sm text-destructive">
                Enter an amount between {formatPrice(TIP_MIN_CENTS, currency)} and{' '}
                {formatPrice(TIP_MAX_CENTS, currency)}.
              </p>
            ) : null}
          </div>

          {tip.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {describeMutationError(tip.error, 'Could not start checkout. Please try again.')}
            </p>
          ) : null}

          <Button type="submit" disabled={!amountCents || tip.isPending} className="rounded-full">
            {tip.isPending
              ? 'Redirecting…'
              : `Tip ${amountCents ? formatPrice(amountCents, currency) : ''}`.trim()}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * What Stripe's redirect back is turned into. Shared by both entry points because
 * both send the viewer home with the same `?tip=` marker.
 *
 * "Thanks" is deliberately not "recorded": the webhook settles the tip a moment
 * later, so the total this page shows may still be one tip behind.
 */
export function TipNotice({ tip }: { tip?: 'success' | 'cancel' }) {
  if (!tip) return null
  return (
    <p role="status" className="text-sm text-slate-500">
      {tip === 'success'
        ? 'Thanks for the tip — the creator will see it shortly.'
        : 'Tip cancelled — you have not been charged.'}
    </p>
  )
}
