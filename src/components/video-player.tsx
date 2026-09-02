import { useEffect, useRef, useState } from 'react'
import videojs from 'video.js'
import type Player from 'video.js/dist/types/player'
import 'video.js/dist/video-js.css'

export type PrerollAd = {
  mediaUrl: string
  durationSeconds: number
  clickThroughUrl: string
  skippableAfterSeconds: number
}

type VideoPlayerProps = {
  src: string
  poster?: string
  preroll?: PrerollAd | null
}

export function VideoPlayer({ src, poster, preroll }: VideoPlayerProps) {
  const videoRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<Player | null>(null)

  const [isAd, setIsAd] = useState(!!preroll)
  // Whole seconds left until the ad becomes skippable.
  const [skipIn, setSkipIn] = useState(preroll?.skippableAfterSeconds ?? 0)

  useEffect(() => {
    if (!videoRef.current) return

    const hasPreroll = !!preroll
    setIsAd(hasPreroll)
    setSkipIn(preroll?.skippableAfterSeconds ?? 0)

    const videoElement = document.createElement('video-js')
    videoElement.classList.add('vjs-big-play-centered')
    videoRef.current.appendChild(videoElement)

    const player = videojs(videoElement, {
      controls: true,
      responsive: true,
      fluid: true,
      poster,
      sources: [{ src: hasPreroll ? preroll!.mediaUrl : src, type: 'video/mp4' }],
    })
    playerRef.current = player

    function playContent() {
      setIsAd(false)
      player.src({ src, type: 'video/mp4' })
      player.play()?.catch(() => {})
    }

    if (hasPreroll) {
      const onTimeUpdate = () => {
        const left = Math.ceil((preroll!.skippableAfterSeconds) - player.currentTime()!)
        setSkipIn(left > 0 ? left : 0)
      }
      const onAdEnded = () => {
        player.off('timeupdate', onTimeUpdate)
        player.off('ended', onAdEnded)
        playContent()
      }
      player.on('timeupdate', onTimeUpdate)
      player.on('ended', onAdEnded)
    }

    return () => {
      player.dispose()
      playerRef.current = null
    }
  }, [src, poster, preroll])

  function skipAd() {
    const player = playerRef.current
    if (!player) return
    setIsAd(false)
    player.src({ src, type: 'video/mp4' })
    player.play()?.catch(() => {})
  }

  const canSkip = skipIn <= 0

  return (
    <div data-vjs-player className="relative">
      <div ref={videoRef} />

      {isAd && preroll && (
        <div className="pointer-events-none absolute inset-0 z-10">
          {/* Clickthrough surface — clicking the ad opens the advertiser link. */}
          {preroll.clickThroughUrl && (
            <a
              href={preroll.clickThroughUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="pointer-events-auto absolute inset-0"
              aria-label="Visit advertiser"
            />
          )}

          <span className="pointer-events-none absolute left-3 top-3 rounded bg-black/70 px-2 py-1 text-xs font-medium text-white">
            Ad
          </span>

          {canSkip ? (
            <button
              type="button"
              onClick={skipAd}
              className="pointer-events-auto absolute bottom-14 right-3 rounded bg-black/70 px-3 py-1.5 text-sm font-medium text-white hover:bg-black/85"
            >
              Skip Ad ▶
            </button>
          ) : (
            <span className="pointer-events-none absolute bottom-14 right-3 rounded bg-black/70 px-3 py-1.5 text-sm text-white">
              Skip in {skipIn}s
            </span>
          )}
        </div>
      )}
    </div>
  )
}
