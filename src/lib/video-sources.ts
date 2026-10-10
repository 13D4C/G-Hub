/**
 * The ordered list of sources handed to video.js for one video.
 *
 * No imports at all, on purpose: `scripts/test-video-sources.ts` loads this under plain
 * `node --experimental-strip-types`, which resolves neither tsconfig paths nor
 * extensionless specifiers. Same arrangement as `video-price.ts`.
 *
 * video.js walks this list and plays the first entry some registered handler claims, so
 * the order *is* the fallback policy:
 *
 * 1. HLS, because it is the only adaptive format with a native safety net — Safari and
 *    iOS play `.m3u8` with no Media Source Extensions at all.
 * 2. DASH, which nothing anywhere plays natively, so it is only ever reachable through
 *    the bundled VHS engine.
 * 3. The original progressive MP4, last — and only while there is no adaptive stream.
 *    It is what plays while a transcode is still queued, or after one has failed. Once the
 *    manifests exist the server stops issuing it (`playbackSourcesFor`): it is the whole
 *    video in one request, which is what "Save video as" and downloader extensions look
 *    for, and nothing needs it — VHS plays the manifests wherever Media Source Extensions
 *    exist, and Safari and iOS play the HLS natively where they do not.
 *
 * This is why the caller passes three strings rather than a prebuilt array: an array
 * literal is a fresh identity on every render, and `<VideoPlayer>` keys its construction
 * effect on primitives precisely so an unrelated re-render cannot dispose the player and
 * restart playback.
 */

/**
 * Spelled exactly as the specs do. The capital `URL` in the HLS type matters: VHS
 * lowercases before matching and tolerates any casing, but the native-playback fallback
 * goes through `canPlayType`, which does not — so a "tidied" spelling here would break
 * only Safari, and only on the path that has no adaptive engine to fall back to.
 */
export const VIDEO_MIME = {
  hls: 'application/x-mpegURL',
  dash: 'application/dash+xml',
  mp4: 'video/mp4',
} as const

export type VideoSource = { src: string; type: string }

export type VideoSourceInput = {
  /** The HLS master playlist, or empty/null until the transcode is ready. */
  hlsUrl?: string | null
  /** The DASH manifest, pointing at the same segments the HLS playlists do. */
  dashUrl?: string | null
  /**
   * The original upload. Empty for a row this viewer may not play, and for a video whose
   * adaptive stream has replaced it.
   */
  mp4Url?: string | null
}

/** Absent, blank and whitespace all mean "this manifest does not exist yet". */
function present(url: string | null | undefined): string {
  return typeof url === 'string' ? url.trim() : ''
}

/**
 * Build the source list, best format first, skipping whatever is absent.
 *
 * Returns an empty array when nothing is present, which is the locked case: the server
 * blanks every url for a viewer who may not play the video, and a source list built from
 * that must offer nothing rather than an entry with an empty `src` that the player would
 * try and fail to load.
 */
export function buildVideoSources(input: VideoSourceInput): VideoSource[] {
  const sources: VideoSource[] = []
  const hls = present(input.hlsUrl)
  const dash = present(input.dashUrl)
  const mp4 = present(input.mp4Url)

  if (hls) sources.push({ src: hls, type: VIDEO_MIME.hls })
  if (dash) sources.push({ src: dash, type: VIDEO_MIME.dash })
  if (mp4) sources.push({ src: mp4, type: VIDEO_MIME.mp4 })

  return sources
}

/**
 * Whether a source type is one the adaptive engine handles — i.e. whether picking it
 * gives the player renditions to switch between at all.
 *
 * The quality panel asks this to tell "still transcoding, nothing to switch" apart from
 * "switching is available", which is the difference between an honest disabled control
 * and one that looks broken.
 */
export function isAdaptiveSource(type: string): boolean {
  return type === VIDEO_MIME.hls || type === VIDEO_MIME.dash
}
