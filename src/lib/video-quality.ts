/**
 * The quality menu: what the player offers, and how each option is labelled.
 *
 * No imports at all, on purpose — `scripts/test-video-quality.ts` loads this under plain
 * `node --experimental-strip-types`, which resolves neither tsconfig paths nor extensionless
 * specifiers. Same arrangement as `video-sources.ts`.
 *
 * Deliberately knows nothing about bandwidth. Picking `720p` means "play this rendition and
 * keep playing it", which the engine implements by having nothing else to choose from — not
 * by being told a number about the connection. `Auto` is the absence of that constraint, and
 * is when the engine's own adaptive logic decides.
 */

/** One rendition, as both a manifest and the ladder can describe it. */
export type SelectableRendition = {
  height: number
  /** Advertised bits per second — the manifest's `BANDWIDTH`, audio included. */
  bandwidth: number
}

/** `null` height is the automatic option; anything else pins that rendition. */
export type QualityOption = {
  /** Stable across re-renders, so it can key a list and identify a radio input. */
  id: string
  label: string
  /** The rendition this option selects, or null to let the player choose. */
  height: number | null
  /** Shown beside the label, empty for `Auto`. */
  detail: string
}

export const AUTO_QUALITY_ID = 'auto'

/** `720p`. Heights come from the manifest, so an odd one is possible and harmless. */
export function formatRenditionLabel(rendition: SelectableRendition): string {
  return `${rendition.height}p`
}

/** `2928 kbps` — the bitrate behind a quality option, so the choice is not just a number of lines. */
export function formatKbps(bps: number): string {
  return `${Math.round(bps / 1000)} kbps`
}

/**
 * Highest quality first, which is the order every familiar player uses.
 *
 * Sorted on bitrate rather than height because that is what the engine ranks by, and because
 * two renditions can share a height at different bitrates — sorting on height would then put
 * them in an order the player does not agree with.
 */
export function sortedByQuality(renditions: readonly SelectableRendition[]): SelectableRendition[] {
  return [...renditions].sort((a, b) => b.bandwidth - a.bandwidth)
}

/**
 * The menu for a given manifest: `Auto`, then every rendition, best first.
 *
 * `Auto` is always present and always first, even when there is exactly one rendition — it is
 * the default, and a menu whose default option vanished in some cases would be stranger than
 * one with a single redundant entry. An empty ladder yields an empty menu, which is the
 * caller's signal that there is nothing to choose and the control should say so.
 */
export function qualityOptionsFrom(renditions: readonly SelectableRendition[]): QualityOption[] {
  if (renditions.length === 0) return []

  const options: QualityOption[] = [
    { id: AUTO_QUALITY_ID, label: 'Auto', height: null, detail: '' },
  ]

  for (const rendition of sortedByQuality(renditions)) {
    options.push({
      // Height alone would collide between two renditions of the same size; the bitrate is
      // what actually distinguishes them, and it is already unique per variant in a manifest.
      id: `q-${rendition.height}-${rendition.bandwidth}`,
      label: formatRenditionLabel(rendition),
      height: rendition.height,
      detail: formatKbps(rendition.bandwidth),
    })
  }

  return options
}

/**
 * Which rendition a chosen height refers to.
 *
 * Matched by height rather than carried around as an object, because the rendition list is
 * rebuilt from the engine every time a source loads — the object a menu was built from is a
 * different object by the time somebody clicks it. Where two renditions share a height, the
 * better one wins, which is the one a viewer asking for "720p" means.
 */
export function renditionForHeight(
  renditions: readonly SelectableRendition[],
  height: number | null,
): SelectableRendition | null {
  if (height === null) return null
  return sortedByQuality(renditions).find((rendition) => rendition.height === height) ?? null
}
