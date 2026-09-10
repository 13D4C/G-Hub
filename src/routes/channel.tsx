import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { EyeOff, Lock, Play, Tv } from 'lucide-react'
import { z } from 'zod'
import { EmptyState } from '@/components/empty-state'
import { MembershipTiersEditor } from '@/components/membership-tiers-editor'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
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
import type { ChannelVideo, ChannelView } from '@/server/functions/channels'
import { describeTierAccess } from '@/lib/membership-tiers'
import type { MembershipTierView } from '@/server/functions/membership-tiers'

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

        {/* Only the subscriber's own billing link lives up here now. Buying is a
            per-tier act, so its buttons belong on the tier cards below. */}
        {channel.isOwner || !channel.subscribed ? null : (
          <div>
            <Button
              variant="outline"
              className="rounded-full"
              onClick={() => manage.mutate()}
              disabled={manage.isPending}
            >
              {manage.isPending ? 'Opening…' : 'Manage subscription'}
            </Button>
          </div>
        )}
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

      {channel.isOwner ? (
        <>
          <ChannelSettings channel={channel} onSaved={refreshChannel} />
          <MembershipTiersEditor
            tiers={channel.tiers}
            currency={channel.currency}
            onChanged={refreshChannel}
          />
        </>
      ) : null}

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
                <ChannelVideoRow video={video} subscribed={channel.subscribed} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Card>
  )
}

/**
 * The creator's own profile controls: what the channel is called and what it says
 * about itself.
 *
 * No price here. A channel cannot sell anything until it has a membership tier, and
 * `MembershipTiersEditor` below is the only place to make one — a second price field
 * is how a channel ends up quoting two figures for the same access.
 */
function ChannelSettings({
  channel,
  onSaved,
}: {
  channel: ChannelView
  onSaved: () => Promise<void>
}) {
  const save = useMutation({
    mutationFn: (data: { channelName: string; channelDescription: string }) =>
      updateChannelSettings({ data }),
    onSuccess: onSaved,
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
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-sm font-semibold tracking-wide text-slate-500 uppercase">
          Your channel
        </h2>
        <p className="text-sm text-slate-500">
          {channel.tiers.length > 0
            ? 'How your channel introduces itself. Pricing lives in your membership tiers below.'
            : 'How your channel introduces itself. Add a membership tier below to start selling access.'}
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
 */
function TierCard({
  tier,
  tiers,
  viewerId,
  creatorId,
  held,
  subscribed,
  busy,
  onSubscribe,
}: {
  tier: MembershipTierView
  tiers: Array<MembershipTierView>
  viewerId: string | null
  creatorId: string
  held: boolean
  subscribed: boolean
  busy: boolean
  onSubscribe: () => void
}) {
  return (
    <div
      className={cn(
        'flex h-full flex-col gap-2 rounded-xl border p-4',
        held && 'border-primary bg-primary/5',
      )}
    >
      <p className="flex items-center gap-2 font-medium text-slate-900">
        {tier.name}
        {held ? (
          <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-normal text-white">
            Your tier
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
          <Button size="sm" className="rounded-full" disabled={busy} onClick={onSubscribe}>
            {busy ? 'Redirecting…' : 'Subscribe'}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * One catalogue row. A locked video is deliberately still listed and still named —
 * it is the thing being sold — but it is not a link, because there is nothing behind
 * it for this viewer yet.
 */
function ChannelVideoRow({ video, subscribed }: { video: ChannelVideo; subscribed: boolean }) {
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
        {video.visibility === 'private' ? (
          <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-normal text-slate-500">
            <EyeOff className="size-3" aria-hidden />
            Private
          </span>
        ) : video.premium ? (
          <span className="rounded-full border px-2 py-0.5 text-xs font-normal text-slate-500">
            {video.requiredTierName || 'Premium'}
          </span>
        ) : null}
      </p>
      {video.description ? <p className="text-sm text-slate-500">{video.description}</p> : null}
    </>
  )

  if (!video.unlocked) {
    // A viewer who is already paying needs to hear "upgrade", not "subscribe" — the
    // same distinction `tierRequired` draws on the server.
    const call = video.requiredTierName
      ? subscribed
        ? `Needs the ${video.requiredTierName} tier.`
        : `Subscribe at ${video.requiredTierName} or higher to watch.`
      : 'Subscribe to watch.'

    return (
      <div className="rounded-xl border border-dashed px-3 py-2 opacity-70">
        {body}
        <p className="text-sm text-slate-500">{call}</p>
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
