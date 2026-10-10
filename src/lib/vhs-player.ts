/**
 * Talking to the adaptive-streaming engine bundled inside video.js.
 *
 * video.js ships `@videojs/http-streaming` (VHS), which plays HLS and DASH and does the
 * actual bitrate switching. None of it is described by video.js's own types — `player.tech()`
 * is typed as a bare `Tech` with no `vhs` on it — so the narrowing lives here, in one module,
 * rather than as casts scattered through the component.
 *
 * Everything below is defensive about the handler being absent, and that is not paranoia:
 * there is no handler while a plain MP4 is playing, none before the first manifest has been
 * parsed, and none at all on a browser playing HLS natively.
 */
import type Player from 'video.js/dist/types/player'
import { renditionForHeight, type SelectableRendition } from './video-quality.ts'

/** One rendition as VHS exposes it, with the enable/disable switch attached. */
type Representation = {
  id: string
  width?: number
  height?: number
  bandwidth: number
  /** Reading takes no argument; writing `true` after `false` forces an immediate switch. */
  enabled: (value?: boolean) => boolean
}

type MediaPlaylist = {
  attributes?: {
    RESOLUTION?: { width: number; height: number }
    BANDWIDTH?: number
  }
}

type PlaylistLoader = {
  media: () => MediaPlaylist | undefined
  on: (event: string, handler: () => void) => void
  off: (event: string, handler: () => void) => void
}

type VhsHandler = {
  /** The engine's rendition chooser. Wrapped, never replaced outright. */
  selectPlaylist: () => unknown
  representations?: () => Representation[]
  playlists?: PlaylistLoader
}

/**
 * The live VHS handler, or null.
 *
 * A fresh handler is built on every `player.src()`, so nothing may hold on to one: a
 * reference taken before the preroll ad finished describes an engine that no longer exists.
 * Always read it again.
 */
export function getVhs(player: Player | null): VhsHandler | null {
  if (!player) return null

  try {
    // The argument only suppresses a warning; this is the spelling video.js uses internally.
    const tech = player.tech({ IWillNotUseThisInPlugins: true }) as unknown as {
      vhs?: VhsHandler
    } | null
    return tech?.vhs ?? null
  } catch {
    // `tech()` throws once the player has been disposed, which a pending event handler can
    // still reach.
    return null
  }
}

/** Whether adaptive playback is actually in charge — the precondition for any of the below. */
export function hasAdaptiveEngine(player: Player | null): boolean {
  const vhs = getVhs(player)
  return !!vhs && typeof vhs.representations === 'function'
}

/** Every rendition the current manifest offers, lowest bitrate first. */
export function availableRenditions(player: Player | null): SelectableRendition[] {
  const reps = getVhs(player)?.representations?.() ?? []

  return reps
    .map((rep) => ({ height: rep.height ?? 0, bandwidth: rep.bandwidth }))
    .filter((rendition) => rendition.bandwidth > 0)
    .sort((a, b) => a.bandwidth - b.bandwidth)
}

/**
 * The rendition playing right now, read from the engine rather than inferred.
 *
 * The runtime source of truth, and the only way to know what `Auto` settled on: the menu
 * says which rendition was *pinned*, which on Auto is none of them. It can also disagree
 * with a pin for a moment, because a switch takes effect at the next segment boundary
 * rather than instantly.
 */
export function activeRendition(player: Player | null): SelectableRendition | null {
  const media = getVhs(player)?.playlists?.media?.()
  if (!media?.attributes) return null

  const { RESOLUTION, BANDWIDTH } = media.attributes
  if (!BANDWIDTH) return null

  return { height: RESOLUTION?.height ?? 0, bandwidth: BANDWIDTH }
}

/**
 * Subscribe to rendition changes. Returns an unsubscribe function.
 *
 * `mediachange` fires once a switch has happened and `mediachanging` as one begins, which is
 * what lets the readout show that something is in progress rather than appearing to freeze
 * for the second the new segment takes to arrive.
 */
export function onRenditionChange(player: Player | null, handler: () => void): () => void {
  const playlists = getVhs(player)?.playlists
  if (!playlists) return () => {}

  playlists.on('mediachange', handler)
  playlists.on('mediachanging', handler)

  return () => {
    try {
      playlists.off('mediachange', handler)
      playlists.off('mediachanging', handler)
    } catch {
      // The loader goes away with the handler on the next `src()`; unsubscribing from one
      // that has already gone is not a problem worth reporting.
    }
  }
}

/**
 * Pin playback to one rendition, or hand the choice back to the player.
 *
 * `null` is Auto: every rendition is enabled and the engine's own adaptive logic decides,
 * which is the normal behaviour of an adaptive player. Any other value narrows the enabled
 * set to that one rendition, so there is nothing left for the engine to switch to — which is
 * what "720p" means in a quality menu, and is how it stays 720p rather than drifting back up
 * or down a moment later.
 *
 * Safe to call when there is no adaptive engine — while a progressive file plays, before the
 * first manifest is parsed, or on a browser handling the stream natively. It does nothing,
 * which is why the caller can apply it on every change without checking first.
 */
export function applyQualitySelection(player: Player | null, height: number | null): void {
  const vhs = getVhs(player)
  const reps = vhs?.representations?.()
  if (!reps || reps.length === 0) return

  if (height === null) {
    for (const rep of reps) {
      if (!rep.enabled()) rep.enabled(true)
    }
    return
  }

  const target = renditionForHeight(
    reps.map((rep) => ({ height: rep.height ?? 0, bandwidth: rep.bandwidth })),
    height,
  )

  // Asking for a rendition this manifest does not carry leaves the selection alone rather
  // than disabling everything. The enabled set must never be emptied: the engine falls back
  // to "every rendition that is not disabled" when it is, so an empty set does not pin
  // anything — it quietly un-pins it.
  if (!target) return

  const targetRep = reps.find((rep) => rep.bandwidth === target.bandwidth)
  if (!targetRep) return

  for (const rep of reps) {
    const wanted = rep === targetRep
    if (rep.enabled() !== wanted) rep.enabled(wanted)
  }

  // Enabling a rendition that was already enabled fires nothing, so a selection made while
  // that rendition happened to be playing would take effect only at the next segment
  // boundary — up to a segment of apparently doing nothing. The off-then-on transition is
  // the engine's own way of saying "switch to this one now".
  targetRep.enabled(false)
  targetRep.enabled(true)
}
