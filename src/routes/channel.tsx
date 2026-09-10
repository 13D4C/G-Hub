import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Lock, Play, Tv } from 'lucide-react'
import { z } from 'zod'
import { EmptyState } from '@/components/empty-state'
import { TipButton, TipNotice } from '@/components/tip-button'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { describeMutationError, meQueryOptions } from '@/lib/auth'
import { channelKeys, channelQueryOptions, formatPeriodEnd, formatPrice } from '@/lib/channels'
import {
  confirmChannelCheckout,
  openBillingPortal,
  startChannelCheckout,
  updateChannelSettings,
} from '@/server/functions/channels'
import type { ChannelVideo, ChannelView } from '@/server/functions/channels'

const channelSearchSchema = z.object({
  id: z.string(),
  /** Set by Stripe when it returns the viewer here. */
  checkout: z.enum(['success', 'cancel']).optional().catch(undefined),
  session_id: z.string().optional().catch(undefined),
  /** Set by Stripe when it returns a viewer here after a one-time tip. */
  tip: z.enum(['success', 'cancel']).optional().catch(undefined),
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

  /** Refresh every viewer's copy of this channel. */
  const refreshChannel = () =>
    queryClient.invalidateQueries({ queryKey: channelKeys.detailPrefix(search.id) })

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
    return <EmptyState icon={Tv} message="Loading channel…" />
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
    <Card variant="glass" className="flex flex-col gap-6 p-6">
      <Card className="flex flex-col gap-4 p-6">
        <div className="flex flex-col gap-1">
          <CardTitle className="font-display text-2xl text-slate-900">{channel.name}</CardTitle>
          <CardDescription className="text-slate-500">
            {channel.description ||
              `${channel.videos.length} video${channel.videos.length === 1 ? '' : 's'}${
                premiumCount ? `, ${premiumCount} premium` : ''
              }.`}
          </CardDescription>
        </div>

        {channel.isOwner ? null : channel.subscribed ? (
          <p className="text-sm text-slate-700">
            <span className="font-semibold text-primary">Subscribed</span>
            {channel.currentPeriodEnd ? (
              <span className="text-slate-500">
                {' '}
                — {channel.cancelAtPeriodEnd ? 'ends' : 'renews'}{' '}
                {formatPeriodEnd(channel.currentPeriodEnd)}
              </span>
            ) : null}
          </p>
        ) : priced ? (
          <p className="text-sm text-slate-500">
            <span className="text-2xl font-semibold text-slate-900">{price}</span> / month —
            unlocks {premiumCount || 'all'} premium video{premiumCount === 1 ? '' : 's'} on this
            channel.
          </p>
        ) : (
          <p className="text-sm text-slate-500">This channel is not accepting subscribers yet.</p>
        )}

        {/* Only once someone has actually tipped — a channel sitting at "$0.00 in
            tips" reads worse than a channel saying nothing. */}
        {channel.tipTotalCents > 0 ? (
          <p className="text-sm text-slate-500">
            <span className="font-semibold text-slate-900">
              {formatPrice(channel.tipTotalCents, channel.currency)}
            </span>{' '}
            in tips from viewers.
          </p>
        ) : null}

        <TipNotice tip={search.tip} />

        {/* Stripe redirects back mid-payment; say so rather than showing a bare
            "Subscribe" as if nothing had happened. */}
        {search.checkout === 'cancel' ? (
          <p role="status" className="text-sm text-slate-500">
            Checkout cancelled — you have not been charged.
          </p>
        ) : null}
        {confirm.isPending ? (
          <p role="status" className="text-sm text-slate-500">
            Confirming your payment…
          </p>
        ) : null}
        {confirm.isSuccess ? (
          <p role="status" className="text-sm font-medium text-primary">
            Payment complete — premium videos are unlocked.
          </p>
        ) : null}

        {errorMessage ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}

        {channel.isOwner ? null : (
          <div className="flex flex-wrap items-center gap-2">
            {!viewerId ? (
              <Button asChild className="rounded-full">
                <Link to="/login" search={{ redirect: `/channel?id=${channel.creatorId}` }}>
                  Sign in to subscribe{priced ? ` — ${price}/month` : ''}
                </Link>
              </Button>
            ) : channel.subscribed ? (
              <Button
                variant="outline"
                className="rounded-full"
                onClick={() => manage.mutate()}
                disabled={manage.isPending}
              >
                {manage.isPending ? 'Opening…' : 'Manage subscription'}
              </Button>
            ) : (
              <Button
                className="rounded-full"
                onClick={() => subscribe.mutate()}
                disabled={!priced || subscribe.isPending || confirm.isPending}
              >
                {subscribe.isPending ? 'Redirecting…' : `Subscribe — ${price}/month`}
              </Button>
            )}

            {/* Tipping needs no subscription and no price on the channel — it is
                open even where `Subscribe` is disabled. Signed-out viewers already
                have the sign-in button above, so this stays out of their way. */}
            {viewerId ? (
              <TipButton
                creatorId={channel.creatorId}
                creatorName={channel.name}
                currency={channel.currency}
                redirect={`/channel?id=${channel.creatorId}`}
              />
            ) : null}
          </div>
        )}
      </Card>

      {channel.isOwner ? <ChannelSettings channel={channel} onSaved={refreshChannel} /> : null}

      <Card className="flex flex-col gap-4 p-6">
        <h2 className="font-display text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Videos
        </h2>
        {channel.videos.length === 0 ? (
          <EmptyState icon={Tv} message="This channel has no videos yet." />
        ) : (
          <ul className="flex flex-col gap-2">
            {channel.videos.map((video) => (
              <li key={video.id}>
                <ChannelVideoRow video={video} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Card>
  )
}

/**
 * The creator's own controls. A channel cannot sell anything until it has a price,
 * and this is the only place to set one — so it lives on the channel page rather
 * than behind a separate settings route.
 */
function ChannelSettings({
  channel,
  onSaved,
}: {
  channel: ChannelView
  onSaved: () => Promise<void>
}) {
  // Edited as a decimal string so the field behaves like a price; converted to minor
  // units at submit, which is the only unit the server and Stripe ever see.
  const [price, setPrice] = useState((channel.priceCents / 100).toFixed(2))

  const save = useMutation({
    mutationFn: (data: {
      channelName: string
      channelDescription: string
      subscriptionPriceCents: number
    }) => updateChannelSettings({ data }),
    onSuccess: onSaved,
  })

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    save.mutate({
      channelName: String(form.get('channelName') ?? '').trim(),
      channelDescription: String(form.get('channelDescription') ?? '').trim(),
      subscriptionPriceCents: Math.round(Number(price || 0) * 100),
    })
  }

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Your channel
        </h2>
        <p className="text-sm text-slate-500">
          {channel.priceCents > 0
            ? 'Viewers pay this every month to unlock your premium videos.'
            : 'Set a price above $0.50 to start selling access to your premium videos.'}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="channelName">Channel name</Label>
          <Input
            id="channelName"
            name="channelName"
            defaultValue={channel.name}
            maxLength={80}
            placeholder="My channel"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="channelDescription">Description</Label>
          <Textarea
            id="channelDescription"
            name="channelDescription"
            defaultValue={channel.description}
            maxLength={500}
            rows={3}
            placeholder="What subscribers get."
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="price">Monthly price (USD)</Label>
          <Input
            id="price"
            name="price"
            type="number"
            min="0"
            step="0.01"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            className="max-w-40"
          />
          <p className="text-xs text-slate-500">
            0 stops new subscriptions. Existing subscribers keep the price they signed up at.
          </p>
        </div>

        {save.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {describeMutationError(save.error, 'Could not save your channel. Please try again.')}
          </p>
        ) : null}
        {save.isSuccess ? (
          <p role="status" className="text-sm text-primary">
            Saved.
          </p>
        ) : null}

        <Button type="submit" className="w-fit rounded-full" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save channel'}
        </Button>
      </form>
    </Card>
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
      <p className="flex items-center gap-2 font-medium text-slate-900">
        {video.premium ? (
          video.unlocked ? (
            <Play className="size-4 shrink-0 text-primary" aria-hidden />
          ) : (
            <Lock className="size-4 shrink-0 text-slate-400" aria-hidden />
          )
        ) : null}
        {video.title}
        {video.premium ? (
          <span className="rounded-full border px-2 py-0.5 text-xs font-normal text-slate-500">
            Premium
          </span>
        ) : null}
      </p>
      {video.description ? <p className="text-sm text-slate-500">{video.description}</p> : null}
    </>
  )

  if (!video.unlocked) {
    return (
      <div className="rounded-xl border border-dashed px-3 py-2 opacity-70">
        {body}
        <p className="text-sm text-slate-500">Subscribe to watch.</p>
      </div>
    )
  }

  return (
    <Link
      to="/video"
      search={{ id: video.id }}
      className="block rounded-xl border px-3 py-2 transition hover:bg-slate-50"
    >
      {body}
    </Link>
  )
}
