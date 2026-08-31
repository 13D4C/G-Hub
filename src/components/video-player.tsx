import { useEffect, useRef } from 'react'
import videojs from 'video.js'
import type Player from 'video.js/dist/types/player'
import 'video.js/dist/video-js.css'

type VideoPlayerProps = {
  src: string
  poster?: string
}

export function VideoPlayer({ src, poster }: VideoPlayerProps) {
  const videoRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<Player | null>(null)

  useEffect(() => {
    if (!videoRef.current) return

    const videoElement = document.createElement('video-js')
    videoElement.classList.add('vjs-big-play-centered')
    videoRef.current.appendChild(videoElement)

    const player = videojs(videoElement, {
      controls: true,
      responsive: true,
      fluid: true,
      poster,
      sources: [{ src, type: 'video/mp4' }],
    })
    playerRef.current = player

    return () => {
      player.dispose()
      playerRef.current = null
    }
  }, [src, poster])

  return (
    <div data-vjs-player>
      <div ref={videoRef} />
    </div>
  )
}
