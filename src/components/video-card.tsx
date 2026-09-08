import { useEffect, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { Lock, Play } from 'lucide-react'
import { cn, formatDuration } from '@/lib/utils'
import type { listVideos } from '@/server/functions/videos'

type VideoSummary = Awaited<ReturnType<typeof listVideos>>[number]

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
      className={cn(
        'h-full w-full object-cover transition-transform duration-500 group-hover:scale-105',
        blurred && 'scale-110 blur-lg',
      )}
    />
  )
}

export function VideoCard({
  video,
  variant = 'grid',
}: {
  video: VideoSummary
  variant?: 'grid' | 'list'
}) {
  const isPrivate = video.visibility === 'private'
  const isGrid = variant === 'grid'

  const thumbnail = (
    <div
      className={cn(
        'group relative overflow-hidden bg-slate-900',
        isGrid ? 'aspect-video w-full' : 'aspect-video w-44 shrink-0 rounded-xl sm:w-52',
      )}
    >
      <VideoThumbnail src={video.url} blurred={isPrivate} />

      {isPrivate ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/55">
          <Lock className={isGrid ? 'size-9 text-white/90' : 'size-6 text-white/90'} />
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
          {video.durationSeconds > 0 && (
            <span
              className={cn(
                'absolute bottom-2 right-2 rounded bg-black/80 font-medium text-white',
                isGrid ? 'px-2 py-1 text-sm' : 'px-1.5 py-0.5 text-xs',
              )}
            >
              {formatDuration(video.durationSeconds)}
            </span>
          )}
        </>
      )}
    </div>
  )

  const meta = (
    <div className={cn('min-w-0', isGrid ? 'flex flex-col gap-1.5 p-5' : 'flex-1 gap-1 py-1')}>
      <p
        className={cn(
          'font-display line-clamp-2 font-semibold text-slate-900',
          isGrid ? 'text-lg' : 'text-sm',
        )}
      >
        {video.title}
      </p>
      <p className={cn('line-clamp-2 text-slate-500', isGrid ? 'text-sm' : 'text-xs')}>
        {isPrivate ? 'Private video' : video.description || 'Public video'}
      </p>
    </div>
  )

  const layoutClass = cn(
    'bg-[#e5e5e5] shadow-xl ring-1 ring-black/5 transition-transform',
    isGrid
      ? 'flex flex-col overflow-hidden rounded-3xl hover:-translate-y-1'
      : 'flex items-start gap-4 overflow-hidden rounded-2xl p-3',
    isPrivate && 'cursor-not-allowed opacity-90 hover:translate-y-0',
  )

  if (isPrivate) {
    return (
      <div className={layoutClass}>
        {thumbnail}
        {meta}
      </div>
    )
  }

  return (
    <Link to="/video" search={{ id: video.id }} className={layoutClass}>
      {thumbnail}
      {meta}
    </Link>
  )
}
