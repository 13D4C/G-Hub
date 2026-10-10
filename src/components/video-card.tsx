import { useEffect, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { Lock, Play } from 'lucide-react'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { cn, formatDuration } from '@/lib/utils'
import { formatPrice } from '@/lib/channels'
import { feedReasonLabel } from '@/lib/feed-reason'
import type { VideoSummary } from '@/lib/video-summary-types'

function VideoThumbnail({ src, blurred }: { src: string; blurred?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    function seekToFrame() {
      try {
        video!.currentTime = Math.min(1.5, (video!.duration || 3) / 2)
      } catch {}
    }

    video.addEventListener('loadedmetadata', seekToFrame)
    return () => video.removeEventListener('loadedmetadata', seekToFrame)
  }, [])

  return (
    <video
      ref={videoRef}
      src={src}
      muted
      playsInline
      preload="metadata"
      // A preview frame, never a file to take away: no "Save video as", no download or
      // cast control, no picture-in-picture.
      controlsList="nodownload noremoteplayback"
      disablePictureInPicture
      disableRemotePlayback
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        'h-full w-full object-cover transition-transform duration-500 group-hover:scale-105',
        blurred && 'scale-110 blur-lg',
      )}
    />
  )
}

/**
 * Where the card's thumbnail and title point.
 *
 * A locked card is not a dead end — it is the shop window, so it links to wherever the
 * key is sold. Which place that is depends on what is being sold: a `subscriber` video
 * is bought on the channel page, alongside the ladder, while a `buyer` video is bought
 * on its own page, where the price and the button live. Sending a pay-per-view card to
 * the channel would offer a subscription that deliberately does not include it.
 *
 * Only a locked video with no channel at all has nowhere to go, and that one renders
 * inert.
 *
 * The channel name is a separate link (see below), so this deliberately wraps only
 * part of the card: nesting an anchor inside an anchor is invalid HTML and browsers
 * resolve it by dropping one of them.
 */
function CardTarget({
  video,
  className,
  children,
  hideChannelLink,
}: {
  video: VideoSummary
  className?: string
  children: React.ReactNode
  hideChannelLink?: boolean
}) {
  if (video.unlocked || (video.payPerView && video.channel)) {
    return (
      <Link to="/video" search={{ id: video.id }} className={className}>
        {children}
      </Link>
    )
  }
  if (video.channel && !hideChannelLink) {
    return (
      <Link to="/channel" search={{ id: video.channel.creatorId }} className={className}>
        {children}
      </Link>
    )
  }
  return <div className={cn(className, 'cursor-not-allowed')}>{children}</div>
}

export function VideoCard({
  video,
  variant = 'grid',
  hideChannelLink = false,
}: {
  video: VideoSummary
  variant?: 'grid' | 'list'
  hideChannelLink?: boolean
}) {
  const locked = !video.unlocked
  const isGrid = variant === 'grid'
  const reasonLabel = video.reason ? feedReasonLabel(video.reason, video.channel?.name) : ''
  // The price, once, for the overlay and the subtitle. Null when this is not a
  // pay-per-view card, or when one somehow has no price to quote.
  const price =
    video.payPerView && video.priceCents !== null && video.channel
      ? formatPrice(video.priceCents, video.channel.currency)
      : null

  const thumbnail = (
    <>
      {video.url ? <VideoThumbnail src={video.url} blurred={locked} /> : null}

      {locked ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/55">
          <Lock className={isGrid ? 'size-9 text-white/90' : 'size-6 text-white/90'} />
          {isGrid ? (
            <span className="text-xs font-medium text-white/80">
              {video.payPerView ? (price ?? 'Pay-per-view') : 'Subscribers only'}
            </span>
          ) : null}
        </div>
      ) : (
        <>
          <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-black/70 via-black/0 to-black/0 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            <div
              className={cn(
                'flex items-center justify-center rounded-full bg-white/90 shadow-lg',
                isGrid ? 'size-16' : 'size-10',
              )}
            >
              <Play
                className={cn('translate-x-0.5 fill-slate-900 text-slate-900', isGrid ? 'size-7' : 'size-4')}
              />
            </div>
          </div>
          {/* Unlocked but not public: say which, otherwise a subscriber cannot
              tell what their subscription is paying for, and a creator cannot tell
              at a glance that a video is still hidden from everyone. A `private`
              card only ever reaches its own uploader — `listVideos` filters it out
              for everybody else. */}
          {video.visibility !== 'public' ? (
            <span
              className={cn(
                'absolute top-2 left-2 rounded px-1.5 py-0.5 text-xs font-medium text-white',
                video.visibility === 'private' ? 'bg-slate-700/90' : 'bg-primary/90',
              )}
            >
              {/* Names what the video is, not what the viewer did to get it — this
                  badge is drawn on the *unlocked* card, which for a `buyer` video
                  means either a purchaser or the creator, and only one of those
                  bought anything. */}
              {video.visibility === 'private'
                ? 'Private'
                : video.visibility === 'buyer'
                  ? 'Pay-per-view'
                  : 'Premium'}
            </span>
          ) : null}
          {video.durationSeconds > 0 && (
            <span
              className={cn(
                'absolute right-2 bottom-2 rounded bg-black/80 font-medium text-white',
                isGrid ? 'px-2 py-1 text-sm' : 'px-1.5 py-0.5 text-xs',
              )}
            >
              {formatDuration(video.durationSeconds)}
            </span>
          )}
        </>
      )}
    </>
  )

  const subtitle = locked
    ? video.payPerView
      ? price
        ? `Buy for ${price} to watch`
        : 'Sold on its own'
      : video.channel && !hideChannelLink
        ? `Subscribe to ${video.channel.name} to watch`
        : 'Subscribe to watch'
    : video.description

  return (
    <Card
      variant="solid"
      className={cn(
        'gap-0 overflow-hidden py-0 transition-transform',
        isGrid ? 'hover:-translate-y-1' : 'flex-row items-start gap-4 rounded-2xl p-3',
        locked && !(video.channel && !hideChannelLink) && 'opacity-90',
      )}
    >
      <CardTarget
        video={video}
        hideChannelLink={hideChannelLink}
        className={cn(
          'group relative block overflow-hidden bg-slate-900',
          isGrid ? 'aspect-video w-full' : 'aspect-video w-44 shrink-0 rounded-xl sm:w-52',
        )}
      >
        {thumbnail}
      </CardTarget>

      <div className={cn('min-w-0', isGrid ? 'flex flex-col gap-1.5 p-5' : 'flex-1 gap-1 py-1')}>
        {reasonLabel ? (
          <span
            className={cn(
              'text-primary/80 font-medium tracking-wide uppercase',
              isGrid ? 'text-xs' : 'text-[11px]',
            )}
          >
            {reasonLabel}
          </span>
        ) : null}

        <CardTarget video={video} hideChannelLink={hideChannelLink}>
          <CardTitle
            className={cn('font-display line-clamp-2 text-slate-900', isGrid ? 'text-lg' : 'text-sm')}
          >
            {video.title}
          </CardTitle>
        </CardTarget>

        {/* The only way to reach a channel you do not already have a locked video
            from — without it, a creator who publishes nothing premium is
            unreachable from the catalogue. */}
        {video.channel && !hideChannelLink ? (
          <Link
            to="/channel"
            search={{ id: video.channel.creatorId }}
            className={cn(
              'w-fit font-medium text-slate-500 underline-offset-4 hover:text-slate-900 hover:underline',
              isGrid ? 'text-sm' : 'text-xs',
            )}
          >
            {video.channel.name}
          </Link>
        ) : null}

        {subtitle ? (
          <CardDescription
            className={cn('line-clamp-2 text-slate-500', isGrid ? 'text-sm' : 'text-xs')}
          >
            {subtitle}
          </CardDescription>
        ) : null}
      </div>
    </Card>
  )
}
