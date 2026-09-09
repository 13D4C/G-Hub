import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Lock, Play } from 'lucide-react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { describeMutationError, meQueryOptions } from '@/lib/auth'
import {
  channelKeys,
  channelQueryOptions,
  formatPeriodEnd,
  formatPrice,
} from '@/lib/channels'
import {
  confirmChannelCheckout,
  openBillingPortal,
  startChannelCheckout,
} from '@/server/functions/channels'
import type { ChannelVideo } from '@/server/functions/channels'

const channelSearchSchema = z.object({
  id: z.string(),
  /** Set by Stripe when it returns the viewer here. */
  checkout: z.enum(['success', 'cancel']).optional().catch(undefined),
  session_id: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/channel')({
  validateSearch: channelSearchSchema,
  loaderDeps: ({ search }) => ({ id: search.id }),
  loader: async ({ deps, context }) => {
    // Warmed rather than returned as loader data, matching `/video`: the subscribe
    // mutation invalidates this key, and invalidating a loader instead would
    // re-run every sibling query on the page.
    const viewer = await context.queryClient.ensureQueryData(meQueryOptions)
    await context.queryClient.ensureQueryData(channelQueryOptions(deps.id, viewer?.id ?? null))
  },
  component: ChannelPage,
})

function ChannelPage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: viewer } = useQuery(meQueryOptions)
  const viewerId = viewer?.id ?? null

  const { data: channel } = useQuery(channelQueryOptions(search.id, viewerId))

  /** Refresh every viewer's copy of this channel, plus the video route's loader data. */
  async function refreshChannel() {
    await queryClient.invalidateQueries({ queryKey: channelKeys.detailPrefix(search.id) })
  }

  const subscribe = useMutation({
    mutationFn: () => startChannelCheckout({ data: { creatorId: search.id } }),
    // A full page assignment, not a router navigation: Checkout is Stripe's origin.
    onSuccess: (result) => {
      window.location.href = result.url
    },
  })

  const manage = useMutation({
    mutationFn: () => openBillingPortal({ data: { creatorId: search.id } }),
    onSuccess: (result) => {
      window.location.href = result.url
    },
  })

  const confirm = useMutation({
    mutationFn: (sessionId: string) =>
      confirmChannelCheckout({ data: { creatorId: search.id, sessionId } }),
    onSuccess: async () => {
      await refreshChannel()
      // Drop the Stripe params so a refresh (or a shared URL) does not re-confirm.
      await navigate({ to: '/channel', search: { id: search.id }, replace: true })
    },
  })

  /**
   * Settle the payment the moment the viewer lands back from Checkout, so premium
   * videos unlock now rather than whenever the webhook happens to arrive.
   *
   * The ref guards React 19's development double-effect and any re-render before
   * the URL is cleaned up; the server function is idempotent either way, this just
   * avoids a second round trip.
   */
  const confirmedSession = useRef<string>(undefined)
  const confirmMutate = confirm.mutate
  useEffect(() => {
    if (search.checkout !== 'success' || !search.session_id) return
    if (confirmedSession.current === search.session_id) return
    confirmedSession.current = search.session_id
    confirmMutate(search.session_id)
  }, [search.checkout, search.session_id, confirmMutate])

  if (!channel) {
    return <p className="text-sm text-muted-foreground">Loading channel…</p>
  }

  const priced = channel.priceCents > 0
  const price = formatPrice(channel.priceCents, channel.currency)
  const premiumCount = channel.videos.filter((v) => v.premium).length

  const errorMessage = subscribe.isError
    ? describeMutationError(subscribe.error, 'Could not start checkout. Please try again.')
    : confirm.isError
      ? describeMutationError(confirm.error, 'Could not confirm your payment. Please try again.')
      : manage.isError
        ? describeMutationError(manage.error, 'Could not open the billing portal.')
        : undefined

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{channel.name}</CardTitle>
          <CardDescription>
            {channel.description ||
              `${channel.videos.length} video(s)${premiumCount ? `, ${premiumCount} premium` : ''}.`}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-2">
          {channel.isOwner ? (
            <p className="text-sm text-muted-foreground">
              This is your channel.{' '}
              {priced
                ? `Viewers pay ${price}/month to unlock your premium videos.`
                : 'Set a subscription price to start selling premium access.'}
            </p>
          ) : channel.subscribed ? (
            <p className="text-sm">
              <span className="font-medium text-primary">Subscribed</span>
              {channel.currentPeriodEnd ? (
                <span className="text-muted-foreground">
                  {' '}
                  — {channel.cancelAtPeriodEnd ? 'ends' : 'renews'}{' '}
                  {formatPeriodEnd(channel.currentPeriodEnd)}
                </span>
              ) : null}
            </p>
          ) : priced ? (
            <p className="text-sm text-muted-foreground">
              <span className="text-lg font-semibold text-foreground">{price}</span> / month —
              unlocks {premiumCount || 'all'} premium video
              {premiumCount === 1 ? '' : 's'} on this channel.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              This channel is not accepting subscribers yet.
            </p>
          )}

          {/* Stripe redirects back mid-payment; say so rather than showing a bare
              "Subscribe" as if nothing had happened. */}
          {search.checkout === 'cancel' ? (
            <p role="status" className="text-sm text-muted-foreground">
              Checkout cancelled — you have not been charged.
            </p>
          ) : null}
          {confirm.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Confirming your payment…
            </p>
          ) : null}
          {confirm.isSuccess ? (
            <p role="status" className="text-sm text-primary">
              Payment complete — premium videos are unlocked.
            </p>
          ) : null}

          {errorMessage ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}
        </CardContent>

        <CardFooter className="gap-2">
          {channel.isOwner ? null : !viewerId ? (
            <Button asChild>
              <Link to="/login" search={{ redirect: `/channel?id=${channel.creatorId}` }}>
                Sign in to subscribe{priced ? ` — ${price}/month` : ''}
              </Link>
            </Button>
          ) : channel.subscribed ? (
            <Button
              variant="outline"
              onClick={() => manage.mutate()}
              disabled={manage.isPending}
            >
              {manage.isPending ? 'Opening…' : 'Manage subscription'}
            </Button>
          ) : (
            <Button
              onClick={() => subscribe.mutate()}
              disabled={!priced || subscribe.isPending || confirm.isPending}
            >
              {subscribe.isPending ? 'Redirecting…' : `Subscribe — ${price}/month`}
            </Button>
          )}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Videos</CardTitle>
        </CardHeader>
        <CardContent>
          {channel.videos.length === 0 ? (
            <p className="text-sm text-muted-foreground">This channel has no videos yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {channel.videos.map((video) => (
                <li key={video.id}>
                  <ChannelVideoRow video={video} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * One catalogue row. A locked video is deliberately still listed and still named —
 * it is the thing being sold — but it is not a link, because there is nothing behind
 * it for this viewer yet.
 */
function ChannelVideoRow({ video }: { video: ChannelVideo }) {
  const body = (
    <>
      <p className="flex items-center gap-2 font-medium">
        {video.premium ? (
          video.unlocked ? (
            <Play className="size-4 shrink-0 text-primary" aria-hidden />
          ) : (
            <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )
        ) : null}
        {video.title}
        {video.premium ? (
          <span className="rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
            Premium
          </span>
        ) : null}
      </p>
      {video.description ? (
        <p className="text-sm text-muted-foreground">{video.description}</p>
      ) : null}
    </>
  )

  if (!video.unlocked) {
    return (
      <div className="rounded-md border border-dashed px-3 py-2 opacity-70">
        {body}
        <p className="text-sm text-muted-foreground">Subscribe to watch.</p>
      </div>
    )
  }

  return (
    <Link
      to="/video"
      search={{ id: video.id }}
      className="block rounded-md border px-3 py-2 hover:bg-accent"
    >
      {body}
    </Link>
  )
}
