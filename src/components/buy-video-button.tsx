import { useEffect, useRef } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { Ticket } from 'lucide-react'
import { SignInPrompt } from '@/components/sign-in-prompt'
import { Button } from '@/components/ui/button'
import { describeMutationError, meQueryOptions } from '@/lib/auth'
import { formatPrice } from '@/lib/channels'
import { confirmVideoPurchase, startVideoPurchaseCheckout } from '@/server/functions/video-purchases'

/**
 * Buy one pay-per-view video. Rendered inside the paywall, because the video page is
 * this thing's shop — unlike a `subscriber` video, whose price lives on the channel.
 *
 * Buying is permanent, so there is nothing to renew and no billing portal to point at.
 */
export function BuyVideoButton({
  videoId,
  priceCents,
  currency,
  className,
}: {
  videoId: string
  priceCents: number
  currency: string
  className?: string
}) {
  const { data: viewer } = useQuery(meQueryOptions)

  const buy = useMutation({
    mutationFn: () => startVideoPurchaseCheckout({ data: { videoId } }),
    // A full page assignment, not a router navigation: Checkout is Stripe's origin.
    onSuccess: (result) => {
      window.location.href = result.url
    },
  })

  if (!viewer) {
    return <SignInPrompt redirect={`/video?id=${videoId}`} label="Sign in to buy" />
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        className={className}
        disabled={buy.isPending}
        onClick={() => buy.mutate()}
      >
        <Ticket />
        {buy.isPending ? 'Redirecting…' : `Buy for ${formatPrice(priceCents, currency)}`}
      </Button>
      {buy.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {describeMutationError(buy.error, 'Could not start checkout. Please try again.')}
        </p>
      ) : null}
    </div>
  )
}

/**
 * What Stripe's redirect back is turned into — and where the purchase is settled.
 *
 * Settling here as well as in the webhook is the difference between a purchase that
 * survives a missed webhook and one that takes the viewer's money and leaves the video
 * locked. `recordPaidSession` is the same idempotent upsert either way, so whichever
 * path arrives first grants the access and the other is a no-op.
 *
 * Rendered in the *locked* branch of the route, not beside the player: at the moment
 * the viewer lands back here they are still locked, which is the whole reason this
 * runs. On success the route is invalidated so the loader re-runs and the player
 * replaces the paywall without a manual reload.
 */
export function PurchaseNotice({
  videoId,
  purchase,
  sessionId,
}: {
  videoId: string
  purchase?: 'success' | 'cancel'
  sessionId?: string
}) {
  const router = useRouter()
  const navigate = useNavigate()

  const confirm = useMutation({
    mutationFn: (id: string) => confirmVideoPurchase({ data: { videoId, sessionId: id } }),
    onSuccess: async () => {
      await router.invalidate()
      // Drop the Stripe params so a refresh — or a shared URL — does not re-confirm.
      await navigate({ to: '/video', search: { id: videoId }, replace: true })
    },
  })

  /**
   * The ref guards React 19's development double-effect and any re-render before the
   * URL is cleaned up. The server function is idempotent either way — this only saves
   * a second round trip.
   */
  const confirmed = useRef<string>(undefined)
  const confirmMutate = confirm.mutate
  useEffect(() => {
    if (purchase !== 'success' || !sessionId) return
    if (confirmed.current === sessionId) return
    confirmed.current = sessionId
    confirmMutate(sessionId)
  }, [purchase, sessionId, confirmMutate])

  if (!purchase) return null

  return (
    <p role="status" className="text-sm text-slate-300">
      {purchase === 'cancel'
        ? 'Purchase cancelled — you have not been charged.'
        : confirm.isError
          ? // The webhook is still coming, so this is a delay and not a loss.
            'Payment received — it is taking a moment to unlock. Refresh in a few seconds.'
          : 'Payment received — unlocking now…'}
    </p>
  )
}
