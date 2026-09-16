import { EmptyState } from '@/components/empty-state'
import { VideoCard } from '@/components/video-card'
import { VideoComments } from '@/components/video-comments'
import { BuyVideoButton, PurchaseNotice } from '@/components/buy-video-button'
import { TipNotice } from '@/components/tip-button'
import { VideoInteractionBar } from '@/components/video-interaction-bar'
import { VideoPlayer } from '@/components/video-player'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { meQueryOptions } from '@/lib/auth'
import { formatPrice } from '@/lib/channels'
import { INTERACTION_ERRORS } from '@/lib/interaction-errors'
import { commentsQueryOptions, interactionSummaryQueryOptions } from '@/lib/interactions'
import { formatDate } from '@/lib/utils'
import { getLockedVideo, getVideoById, listVideos } from '@/server/functions/videos'
import type { LockedVideo, PlaybackData, VideoChannel } from '@/server/functions/videos'
import { createFileRoute, Link } from '@tanstack/react-router'
import { CalendarDays, Droplets, Lock } from 'lucide-react'
import { z } from 'zod'

const videoSearchSchema = z.object({
  id: z.string().optional(),
  /** Set by Stripe when it returns a viewer here after tipping. */
  tip: z.enum(['success', 'cancel']).optional().catch(undefined),
  /** Set by Stripe when it returns a viewer here after buying this video. */
  purchase: z.enum(['success', 'cancel']).optional().catch(undefined),
  /**
   * The Checkout session, settled on arrival by whichever notice is showing. Shared
   * between the two returns because only one of `tip` and `purchase` is ever set.
   */
  session_id: z.string().optional().catch(undefined),
})

/**
 * The three rejections that mean "locked", not "broken": no subscription at all, a
 * subscription on too low a rung of the channel's membership ladder, and a
 * pay-per-view video this viewer has not bought. All are the *expected* path for a
 * gated video, so all are caught below and turned into a prompt. Any other rejection
 * (a missing video, a database outage) is left to propagate to the router's error
 * boundary.
 */
const LOCKED_MESSAGES = new Set<string>([
  INTERACTION_ERRORS.subscriptionRequired,
  INTERACTION_ERRORS.tierRequired,
  INTERACTION_ERRORS.purchaseRequired,
])

/** What would open this video — which decides what the paywall offers. */
type LockKind = 'subscribe' | 'upgrade' | 'buy'

const LOCK_KINDS: Record<string, LockKind> = {
  [INTERACTION_ERRORS.subscriptionRequired]: 'subscribe',
  [INTERACTION_ERRORS.tierRequired]: 'upgrade',
  [INTERACTION_ERRORS.purchaseRequired]: 'buy',
}

/**
 * Playback, or the paywall that stands in for it.
 *
 * Which rejection came back is carried through as `lockKind`, because the three need
 * different things said to them: a viewer already paying for Silver has to be told to
 * upgrade rather than to subscribe, and a viewer looking at a pay-per-view video has
 * to be offered the video — telling them to subscribe would sell them something that
 * does not include it.
 */
async function loadPlayback(videoId: string): Promise<{
  playback: PlaybackData | null
  locked: LockedVideo | null
  lockKind: LockKind
}> {
  try {
    return {
      playback: await getVideoById({ data: { videoId } }),
      locked: null,
      lockKind: 'subscribe',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : ''
    if (!LOCKED_MESSAGES.has(message)) throw error
    return {
      playback: null,
      locked: await getLockedVideo({ data: { videoId } }),
      lockKind: LOCK_KINDS[message] ?? 'subscribe',
    }
  }
}

export const Route = createFileRoute('/video')({
  validateSearch: videoSearchSchema,
  loaderDeps: ({ search }) => ({ id: search.id }),
  loader: async ({ deps, context }) => {
    const videos = await listVideos()
    const { playback, locked, lockKind } = deps.id
      ? await loadPlayback(deps.id)
      : { playback: null, locked: null, lockKind: 'subscribe' as const }

    // Only warm the interaction caches for a video the viewer can actually watch —
    // the interaction handlers apply the same paywall and would reject in the loader.
    if (playback) {
      // Deliberately NOT returned as loader data: that would force interaction
      // mutations to invalidate the loader, handing <VideoPlayer> a fresh `preroll`
      // object and restarting the video mid-playback.
      const viewer = await context.queryClient.ensureQueryData(meQueryOptions)
      await Promise.all([
        context.queryClient.ensureQueryData(
          interactionSummaryQueryOptions(playback.video.id, viewer?.id ?? null),
        ),
        context.queryClient.ensureQueryData(commentsQueryOptions(playback.video.id)),
      ])
    }

    return { videos, playback, locked, lockKind }
  },
  component: VideoPage,
})

function VideoPage() {
  const { videos, playback, locked, lockKind } = Route.useLoaderData()
  const { tip, purchase, session_id } = Route.useSearch()
  const currentId = playback?.video.id ?? locked?.id
  const moreVideos = videos.filter((video) => video.id !== currentId)

  return (
    <Card
      variant="glass"
      className="grid grid-cols-1 gap-10 p-6 sm:p-6 lg:grid-cols-[minmax(0,1fr)_360px]"
    >
      <div className="flex flex-col gap-4">
        {playback ? (
          <>
            <VideoPlayer src={playback.video.url} preroll={playback.preroll} />
            <div className="flex flex-col gap-4">
              <h1 className="font-display text-xl font-semibold text-white sm:text-2xl">
                {playback.video.title}
              </h1>

              <Card className="flex flex-col gap-3 p-5">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
                  <CalendarDays className="size-4" />
                  Uploaded {formatDate(playback.video.createdAt)}
                  {playback.channel ? <ChannelByline channel={playback.channel} /> : null}
                </div>
                <p className="whitespace-pre-line text-sm text-slate-700">
                  {playback.video.description || 'No description provided.'}
                </p>
                <VideoInteractionBar videoId={playback.video.id} channel={playback.channel} />
                <TipNotice tip={tip} sessionId={session_id} />
              </Card>

              <Card className="flex flex-col gap-4 p-5">
                <h2 className="font-display text-sm font-semibold tracking-wide text-slate-500 uppercase">
                  Comments
                </h2>
                <VideoComments videoId={playback.video.id} />
              </Card>
            </div>
          </>
        ) : locked ? (
          <Paywall
            locked={locked}
            lockKind={lockKind}
            purchase={purchase}
            sessionId={session_id}
          />
        ) : (
          <EmptyState icon={Droplets} message="Pick a video from the list to start watching" />
        )}
      </div>

      <aside className="flex flex-col gap-3">
        <h2 className="font-display text-sm font-semibold tracking-wide text-slate-300 uppercase">
          More videos
        </h2>
        {moreVideos.length === 0 ? (
          <EmptyState icon={Droplets} message="Nothing else here yet" />
        ) : (
          moreVideos.map((video) => <VideoCard key={video.id} video={video} variant="list" />)
        )}
      </aside>
    </Card>
  )
}

/** Links a video back to the channel that published it. */
function ChannelByline({ channel }: { channel: VideoChannel }) {
  return (
    <>
      <span aria-hidden>·</span>
      <Link
        to="/channel"
        search={{ id: channel.creatorId }}
        className="font-semibold text-slate-600 underline-offset-4 hover:text-slate-900 hover:underline"
      >
        {channel.name}
      </Link>
    </>
  )
}

/**
 * What a viewer sees instead of the player when they cannot watch a paid video.
 *
 * Three different things are being sold, so the wording and the call to action both
 * split on `lockKind`:
 *
 * - `subscribe` / `upgrade` point at the channel, because that is where a membership
 *   is priced. Telling a paying Silver subscriber to "subscribe" would read as a bug,
 *   and telling a stranger to "upgrade" names a thing they do not have.
 * - `buy` sells the video right here, because a pay-per-view video's price lives on
 *   the video. Sending this viewer to the channel would offer them a subscription
 *   that deliberately does not include what they are looking at.
 *
 * `PurchaseNotice` is rendered here rather than beside the player: a viewer landing
 * back from Checkout is still locked at that moment, which is exactly why it has to
 * settle the payment and re-run the loader.
 */
function Paywall({
  locked,
  lockKind,
  purchase,
  sessionId,
}: {
  locked: LockedVideo
  lockKind: LockKind
  purchase?: 'success' | 'cancel'
  sessionId?: string
}) {
  const tier = locked.requiredTierName
  const forSale = lockKind === 'buy'
  const price =
    locked.priceCents !== null && locked.channel
      ? formatPrice(locked.priceCents, locked.channel.currency)
      : null

  const heading = forSale
    ? 'Pay-per-view video'
    : lockKind === 'upgrade'
      ? `${tier || 'Higher tier'} video`
      : 'Premium video'

  const explanation = !locked.channel
    ? 'This video is not available.'
    : forSale
      ? price
        ? `Buy this one video for ${price} and keep it. A subscription to ${locked.channel.name} does not include it.`
        : `This video is sold on its own, and is not included in a subscription to ${locked.channel.name}.`
      : lockKind === 'upgrade'
        ? tier
          ? `Your membership does not include this. It needs the ${tier} tier on ${locked.channel.name}.`
          : `Your membership tier does not include this video.`
        : tier
          ? `Subscribe to ${locked.channel.name} at ${tier} or higher to watch this.`
          : `Subscribe to ${locked.channel.name} to watch this.`

  return (
    <div className="flex flex-col gap-4">
      <div className="flex aspect-video flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-white/20 bg-black/40 p-8 text-center">
        <Lock className="size-10 text-white/80" aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="font-display text-lg font-semibold text-white">{heading}</p>
          <p className="text-sm text-slate-300">{explanation}</p>
        </div>

        {forSale ? (
          // A price that will not render means the video is not actually sellable —
          // the same condition `startVideoPurchaseCheckout` refuses on — so no button
          // is offered rather than one that would be rejected.
          locked.channel && locked.priceCents !== null ? (
            <BuyVideoButton
              videoId={locked.id}
              priceCents={locked.priceCents}
              currency={locked.channel.currency}
              className="rounded-full"
            />
          ) : null
        ) : locked.channel ? (
          <Button asChild className="rounded-full">
            <Link to="/channel" search={{ id: locked.channel.creatorId }}>
              {lockKind === 'upgrade' ? 'View membership tiers' : 'View subscription options'}
            </Link>
          </Button>
        ) : null}

        <PurchaseNotice videoId={locked.id} purchase={purchase} sessionId={sessionId} />
      </div>

      <h1 className="font-display text-xl font-semibold text-white sm:text-2xl">{locked.title}</h1>
      {locked.description ? (
        <Card className="p-5">
          <p className="whitespace-pre-line text-sm text-slate-700">{locked.description}</p>
        </Card>
      ) : null}
    </div>
  )
}
