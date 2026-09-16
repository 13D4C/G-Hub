import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Layers, Pencil, Tv } from 'lucide-react'
import { z } from 'zod'
import { FALLBACK_AVATAR } from '@/components/auth-nav'
import { EmptyState } from '@/components/empty-state'
import { MembershipTiersEditor } from '@/components/membership-tiers-editor'
import { TipButton, TipNotice } from '@/components/tip-button'
import { VideoCard } from '@/components/video-card'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
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
import { Textarea } from '@/components/ui/textarea'
import { describeMutationError, meQueryOptions } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { channelKeys, channelQueryOptions, formatPeriodEnd, formatPrice } from '@/lib/channels'
import {
  confirmChannelCheckout,
  openBillingPortal,
  startChannelCheckout,
  updateChannelSettings,
} from '@/server/functions/channels'
import type { ChannelView } from '@/server/functions/channels'
import { describeTierAccess } from '@/lib/membership-tiers'
import type { MembershipTierView } from '@/server/functions/membership-tiers'

const channelSearchSchema = z.object({
  id: z.string(),
  /** Set by Stripe when it returns the viewer here. */
  checkout: z.enum(['success', 'cancel']).optional().catch(undefined),
  session_id: z.string().optional().catch(undefined),
  /**
   * Set by Stripe when it returns a viewer here after a one-time tip. It shares
   * `session_id` with the subscription return above — the two never arrive
   * together, since one checkout produces one redirect.
   */
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

  // The tier is the argument, not the channel: one button per rung, all going
  // through the same Checkout. A tier is the only thing a channel sells, so there is
  // no unspecified "subscribe to the channel" purchase to fall back to.
  const subscribe = useMutation({
    mutationFn: (tierId: string) =>
      startChannelCheckout({ data: { creatorId: search.id, tierId } }),
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

  const premiumCount = channel.videos.filter((v) => v.premium).length
  // Membership tiers are the whole of what a channel sells. No tiers means nothing
  // is on offer yet, however many subscriber-only videos are sitting behind it.
  const hasTiers = channel.tiers.length > 0

  const errorMessage = subscribe.isError
    ? describeMutationError(subscribe.error, 'Could not start checkout. Please try again.')
    : confirm.isError
      ? describeMutationError(confirm.error, 'Could not confirm your payment. Please try again.')
      : manage.isError
        ? describeMutationError(manage.error, 'Could not open the billing portal.')
        : undefined

  return (
    <Card variant="glass" className="flex flex-col gap-6 p-6">
      <Card className="flex flex-col items-center gap-4 p-8 text-center sm:p-10">
        <img
          src={channel.avatarUrl || FALLBACK_AVATAR}
          alt=""
          className="size-28 shrink-0 rounded-full object-cover ring-4 ring-white shadow-lg sm:size-32"
        />

        <div className="flex flex-col items-center gap-1">
          <CardTitle className="font-display text-2xl text-slate-900 sm:text-3xl">
            {channel.name}
          </CardTitle>
          <CardDescription className="max-w-xl text-slate-500">
            {channel.description ||
              `${channel.videos.length} video${channel.videos.length === 1 ? '' : 's'}${
                premiumCount ? `, ${premiumCount} premium` : ''
              }.`}
          </CardDescription>
        </div>

        {channel.isOwner ? null : channel.subscribed ? (
          <p className="text-sm text-slate-700">
            <span className="font-semibold text-primary">
              Subscribed{channel.viewerTierName ? ` — ${channel.viewerTierName}` : ''}
            </span>
            {channel.currentPeriodEnd ? (
              <span className="text-slate-500">
                {' '}
                — {channel.cancelAtPeriodEnd ? 'ends' : 'renews'}{' '}
                {formatPeriodEnd(channel.currentPeriodEnd)}
              </span>
            ) : null}
          </p>
        ) : hasTiers ? (
          <p className="text-sm text-slate-500">
            {premiumCount > 0
              ? `Choose a membership tier below to unlock this channel's ${premiumCount} subscriber-only video${premiumCount === 1 ? '' : 's'}.`
              : 'Choose a membership tier below to support this channel. Nothing is subscriber-only yet.'}
          </p>
        ) : (
          <p className="text-sm text-slate-500">
            This channel has no membership tiers yet, so there is nothing to subscribe to.
          </p>
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

        <TipNotice tip={search.tip} sessionId={search.session_id} />

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

        <div className="flex flex-wrap items-center justify-center gap-2">
          {channel.isOwner ? (
            <>
              <EditChannelDialog channel={channel} onSaved={refreshChannel} />
              <MembershipTiersDialog
                tiers={channel.tiers}
                currency={channel.currency}
                onChanged={refreshChannel}
              />
            </>
          ) : (
            <>
              {/* Buying is a per-tier act, so the Subscribe buttons live on the tier
                  cards below; only the subscriber's own billing link belongs here. */}
              {channel.subscribed ? (
                <Button
                  variant="outline"
                  className="rounded-full"
                  onClick={() => manage.mutate()}
                  disabled={manage.isPending}
                >
                  {manage.isPending ? 'Opening…' : 'Manage subscription'}
                </Button>
              ) : null}

              {/* Tipping needs no subscription and no tier — it is open even on a
                  channel that sells nothing. Signed-out viewers get their sign-in
                  link on the tier cards, so this stays out of their way. */}
              {viewerId ? (
                <TipButton
                  creatorId={channel.creatorId}
                  creatorName={channel.name}
                  currency={channel.currency}
                  redirect={`/channel?id=${channel.creatorId}`}
                />
              ) : null}
            </>
          )}
        </div>
      </Card>

      {/* The ladder itself, for anyone who is not its owner — including signed-out
          viewers, who need to see what is on sale before being asked to sign in. */}
      {!channel.isOwner && hasTiers ? (
        <TierPicker
          channel={channel}
          viewerId={viewerId}
          busy={subscribe.isPending || confirm.isPending}
          onSubscribe={(tierId) => subscribe.mutate(tierId)}
        />
      ) : null}

      <Card className="flex flex-col gap-4 p-6">
        <h2 className="font-display text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Videos
        </h2>
        {channel.videos.length === 0 ? (
          <EmptyState icon={Tv} message="This channel has no videos yet." />
        ) : (
          <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
            {channel.videos.map((video) => (
              <VideoCard
                key={video.id}
                hideChannelLink
                video={{
                  ...video,
                  channel: {
                    creatorId: channel.creatorId,
                    name: channel.name,
                    currency: channel.currency,
                    avatarUrl: channel.avatarUrl,
                  },
                }}
              />
            ))}
          </div>
        )}
      </Card>
    </Card>
  )
}

function EditChannelDialog({
  channel,
  onSaved,
}: {
  channel: ChannelView
  onSaved: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)

  const save = useMutation({
    mutationFn: (data: { channelName: string; channelDescription: string }) =>
      updateChannelSettings({ data }),
    onSuccess: async () => {
      await onSaved()
      setOpen(false)
    },
  })

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    save.mutate({
      channelName: String(form.get('channelName') ?? '').trim(),
      channelDescription: String(form.get('channelDescription') ?? '').trim(),
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2 rounded-full">
          <Pencil className="size-4" />
          Edit channel
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit your channel</DialogTitle>
          <DialogDescription>
            {channel.tiers.length > 0
              ? 'How your channel introduces itself. Pricing lives in your membership tiers.'
              : 'How your channel introduces itself. Add a membership tier to start selling access.'}
          </DialogDescription>
        </DialogHeader>

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

          {save.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {describeMutationError(save.error, 'Could not save your channel. Please try again.')}
            </p>
          ) : null}

          <Button type="submit" className="w-fit rounded-full" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save channel'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function MembershipTiersDialog({
  tiers,
  currency,
  onChanged,
}: {
  tiers: Array<MembershipTierView>
  currency: string
  onChanged: () => Promise<void>
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2 rounded-full">
          <Layers className="size-4" />
          Membership tiers
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Membership tiers</DialogTitle>
          <DialogDescription>
            Name your tiers and price each one — this is the only thing your channel sells.
          </DialogDescription>
        </DialogHeader>

        <MembershipTiersEditor tiers={tiers} currency={currency} onChanged={onChanged} />
      </DialogContent>
    </Dialog>
  )
}

/**
 * The rungs of the ladder, as a viewer sees them: cheapest first, each its own
 * Checkout.
 *
 * Signed-out viewers get the same cards with a sign-in link, so the prices are
 * readable before an account exists — a paywall nobody can read is not a paywall.
 */
function TierPicker({
  channel,
  viewerId,
  busy,
  onSubscribe,
}: {
  channel: ChannelView
  viewerId: string | null
  busy: boolean
  onSubscribe: (tierId: string) => void
}) {
  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Membership tiers
        </h2>
        <p className="text-sm text-slate-500">
          Each tier unlocks its own videos plus everything in the tiers below it.
        </p>
      </div>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {channel.tiers.map((tier) => (
          <li key={tier.id}>
            <TierCard
              tier={tier}
              tiers={channel.tiers}
              viewerId={viewerId}
              creatorId={channel.creatorId}
              held={channel.viewerTierId === tier.id}
              pending={channel.pendingTierId === tier.id}
              status={channel.status}
              subscribed={channel.subscribed}
              busy={busy}
              onSubscribe={() => onSubscribe(tier.id)}
            />
          </li>
        ))}
      </ul>
    </Card>
  )
}

/**
 * One rung on sale.
 *
 * A viewer who already subscribes to *another* tier is shown the price but no
 * button: `startChannelCheckout` would reject them, because one row and one Stripe
 * subscription per channel means switching has to go through a cancellation first.
 * Saying that here is better than a button that only fails.
 *
 * `pending` is its own state and must not be confused with `held`. A subscription
 * row is written before the viewer ever reaches Stripe, so abandoning Checkout
 * leaves a row naming this tier with nothing paid against it. Treating that as
 * membership both lies to the viewer and — because it replaces the button — leaves
 * them no way to finish paying.
 */
function TierCard({
  tier,
  tiers,
  viewerId,
  creatorId,
  held,
  pending,
  status,
  subscribed,
  busy,
  onSubscribe,
}: {
  tier: MembershipTierView
  tiers: Array<MembershipTierView>
  viewerId: string | null
  creatorId: string
  held: boolean
  pending: boolean
  status: string
  subscribed: boolean
  busy: boolean
  onSubscribe: () => void
}) {
  // Two different things land in `pending`, and they need different words. A
  // checkout that was opened and walked away from has never been paid; a lapsed or
  // cancelled one was. Telling someone whose card expired that they "did not pay"
  // is both wrong and slightly accusatory.
  const neverPaid = status.startsWith('incomplete')
  return (
    <div
      className={cn(
        'flex h-full flex-col gap-2 rounded-xl border p-4',
        held && 'border-primary bg-primary/5',
        pending && 'border-dashed',
      )}
    >
      <p className="flex items-center gap-2 font-medium text-slate-900">
        {tier.name}
        {held ? (
          <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-normal text-white">
            Your tier
          </span>
        ) : pending ? (
          <span className="rounded-full border px-2 py-0.5 text-xs font-normal text-slate-500">
            {neverPaid ? 'Not paid' : 'Inactive'}
          </span>
        ) : null}
      </p>
      <p className="text-sm text-slate-500">
        <span className="text-xl font-semibold text-slate-900">
          {formatPrice(tier.priceCents, tier.currency)}
        </span>{' '}
        / month
      </p>
      {tier.description ? <p className="text-sm text-slate-500">{tier.description}</p> : null}
      <p className="text-xs text-slate-400">{describeTierAccess(tier, tiers)}</p>

      <div className="mt-auto pt-2">
        {!viewerId ? (
          <Button asChild variant="outline" size="sm" className="rounded-full">
            <Link to="/login" search={{ redirect: `/channel?id=${creatorId}` }}>
              Sign in to subscribe
            </Link>
          </Button>
        ) : held ? (
          <p className="text-xs text-slate-500">You are on this tier.</p>
        ) : subscribed ? (
          <p className="text-xs text-slate-500">
            Cancel your current subscription in the billing portal to switch tiers.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {/* Says what happened before offering the button again: a viewer who
                backed out of Checkout has a row here but no membership, and
                "Subscribe" alone would leave them wondering whether the first
                attempt charged them. */}
            {pending ? (
              <p className="text-xs text-slate-500">
                {neverPaid
                  ? 'You started this checkout but did not pay, so it is not active.'
                  : 'Your subscription to this tier is no longer active.'}
              </p>
            ) : null}
            <Button size="sm" className="rounded-full" disabled={busy} onClick={onSubscribe}>
              {busy
                ? 'Redirecting…'
                : pending
                  ? neverPaid
                    ? 'Complete payment'
                    : 'Subscribe again'
                  : 'Subscribe'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

