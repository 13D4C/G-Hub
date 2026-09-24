import { useCallback, useEffect, useRef, useState } from 'react'
import videojs from 'video.js'
import type Player from 'video.js/dist/types/player'
import 'video.js/dist/video-js.css'
import { Card } from '@/components/ui/card'
import { VideoQualityPanel } from '@/components/video-quality-panel'
import { buildVideoSources, VIDEO_MIME } from '@/lib/video-sources'
import { qualityOptionsFrom, type SelectableRendition } from '@/lib/video-quality'
import type { TranscodeStatus } from '@/lib/transcode-status'
import {
  activeRendition,
  applyQualitySelection,
  availableRenditions,
  hasAdaptiveEngine,
  onRenditionChange,
} from '@/lib/vhs-player'

export type PrerollAd = {
  mediaUrl: string
  durationSeconds: number
  clickThroughUrl: string
  skippableAfterSeconds: number
}

type VideoPlayerProps = {
  /** The original upload. Always playable, and always the last source offered. */
  src: string
  /** Adaptive manifests, empty until this video has been transcoded. */
  hlsUrl?: string
  dashUrl?: string
  /** Only used to explain an absent quality control; never gates playback. */
  transcodeStatus?: TranscodeStatus | null
  poster?: string
  preroll?: PrerollAd | null
}


export function VideoPlayer({
  src,
  hlsUrl,
  dashUrl,
  transcodeStatus,
  poster,
  preroll,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<Player | null>(null)

  /**
   * The ad's exit path, hoisted out of the effect that defines it.
   *
   * `skipAd` used to re-implement this, because the real one is closure-scoped inside the
   * construction effect — two ways out of the ad that had to be kept in step by hand, and
   * were not: each carried its own hardcoded source type. One function behind a ref makes
   * them the same code rather than merely alike.
   */
  const playContentRef = useRef<(() => void) | null>(null)

  /**
   * The viewer's quality choice, mirrored into a ref.
   *
   * The engine is rebuilt from scratch on every `player.src()`, so the choice has to be
   * reapplied when the content source replaces the ad — at which point the effect that owns
   * the state has long since run. The ref is what that later callback reads.
   */
  const qualityRef = useRef<number | null>(null)

  const [isAd, setIsAd] = useState(!!preroll)
  // Whole seconds left until the ad becomes skippable.
  const [skipIn, setSkipIn] = useState(preroll?.skippableAfterSeconds ?? 0)

  /** The pinned rendition height, or null for Auto — which is the default, as it should be. */
  const [selectedHeight, setSelectedHeight] = useState<number | null>(null)
  const [renditions, setRenditions] = useState<SelectableRendition[]>([])
  const [active, setActive] = useState<SelectableRendition | null>(null)
  const [adaptive, setAdaptive] = useState(false)

  useEffect(() => {
    if (!videoRef.current) return

    const hasPreroll = !!preroll
    setIsAd(hasPreroll)
    setSkipIn(preroll?.skippableAfterSeconds ?? 0)

    // Built here from the three url props rather than passed in as an array: an array
    // literal is a fresh identity on every render, and this effect must only re-run when a
    // genuinely different video is being played.
    const contentSources = buildVideoSources({ hlsUrl, dashUrl, mp4Url: src })

    const videoElement = document.createElement('video-js')
    videoElement.classList.add('vjs-big-play-centered')
    videoRef.current.appendChild(videoElement)

    const player = videojs(videoElement, {
      controls: true,
      responsive: true,
      fluid: true,
      autoplay: false,
      poster,
      // The ad stays a single progressive file. Only the content is adaptive, so the ad
      // flow below is unchanged by any of this.
      sources: hasPreroll
        ? [{ src: preroll!.mediaUrl, type: VIDEO_MIME.mp4 }]
        : contentSources,
      html5: {
        // Emulated tracks are the precondition for overriding native playback below.
        nativeAudioTracks: false,
        nativeVideoTracks: false,
        vhs: {
          /**
           * Safari and iOS play HLS natively by default, and native playback exposes no
           * rendition list and no bandwidth estimate — the quality readout would be blank
           * and the simulator would do nothing, with no error to explain either.
           */
          overrideNative: true,
          /**
           * Off, and this is the single most load-bearing line in the feature. It defaults
           * to on, and when on the engine reads the browser's own Network Information
           * estimate *in place of* the stored one — which is every Chromium browser, i.e.
           * the one this will be demonstrated in. Every simulated value would be discarded
           * before the selector ever saw it, silently.
           */
          useNetworkInformationApi: false,
          /**
           * Also off. On, the engine additionally caps renditions to roughly the player's
           * pixel size; in this page's layout that is around 800px wide, so 1080p would
           * never be chosen and the two fastest presets would select the same rendition.
           */
          limitRenditionByPlayerDimensions: false,
        },
      },
    })
    playerRef.current = player

    function playContent() {
      setIsAd(false)
      player.src(contentSources)
      player.play()?.catch(() => {})
    }
    playContentRef.current = playContent

    /**
     * Re-read the engine whenever a source finishes loading.
     *
     * A new handler is built by every `player.src()`, and the rendition list does not exist
     * until the manifest has been parsed — so this is the earliest point any of it can be
     * read, and it has to happen again after the ad hands over to the content.
     */
    let unsubscribe: (() => void) | null = null

    function readEngine() {
      const isAdaptive = hasAdaptiveEngine(player)
      setAdaptive(isAdaptive)
      setRenditions(availableRenditions(player))
      setActive(activeRendition(player))

      if (!isAdaptive) return

      applyQualitySelection(player, qualityRef.current)

      unsubscribe?.()
      unsubscribe = onRenditionChange(player, () => setActive(activeRendition(player)))
    }

    player.on('loadedmetadata', readEngine)

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
      unsubscribe?.()
      player.dispose()
      playerRef.current = null
      playContentRef.current = null
    }
    // Depend on the ad's *values*, not the `preroll` object's identity: the route loader
    // builds a fresh object every run, so an identity dep would dispose and rebuild the
    // player (replaying the ad) on any unrelated loader re-run.
    //
    // `selectedHeight` is deliberately absent for the same reason, and it matters more:
    // choosing a quality would otherwise tear down the player and restart the video from
    // zero — which is precisely what a quality menu must not do. It is applied imperatively
    // to the live player in the effect below instead. The two manifest urls are safe to
    // depend on because they are strings — a loader re-run produces equal values, not new
    // identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `preroll` itself is deliberately excluded; the two fields below are all this effect reads, and `selectedHeight` must never rebuild the player.
  }, [src, hlsUrl, dashUrl, poster, preroll?.mediaUrl, preroll?.skippableAfterSeconds])

  /**
   * Apply the quality choice to the player that already exists.
   *
   * Separate from construction on purpose — see the comment above. Switching quality must
   * not interrupt playback: the engine changes which segments it fetches next and the video
   * keeps running, which is what every familiar player does and what a rebuild would break.
   */
  useEffect(() => {
    qualityRef.current = selectedHeight
    applyQualitySelection(playerRef.current, selectedHeight)
  }, [selectedHeight])

  const skipAd = useCallback(() => {
    playContentRef.current?.()
  }, [])

  const canSkip = skipIn <= 0

  return (
    <Card variant="media" className="gap-0 rounded-2xl bg-black py-0 shadow-2xl ring-white/10">
      <div data-vjs-player className="relative">
        <div ref={videoRef} />

        {isAd && preroll && (
          <div className="pointer-events-none absolute inset-0 z-10">
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

      {/* Below the video rather than inside the control bar: an overlay would compete with
          the ad layer above, and a real video.js control would mean running an imperative
          component inside a React tree. A strip here also survives fullscreen. Hidden while
          the ad plays, which is not this video's quality to talk about. */}
      {!isAd && (
        <VideoQualityPanel
          options={qualityOptionsFrom(renditions)}
          selectedHeight={selectedHeight}
          onSelect={setSelectedHeight}
          active={active}
          adaptive={adaptive}
          transcodeStatus={transcodeStatus}
        />
      )}
    </Card>
  )
}
