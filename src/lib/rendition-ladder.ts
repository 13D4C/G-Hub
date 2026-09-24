/**
 * The rendition ladder: what the transcoder encodes, and what the player switches between.
 *
 * No imports at all, on purpose — the ffmpeg argv builder loads this under plain `node
 * --experimental-strip-types` (which resolves neither tsconfig paths nor extensionless
 * specifiers). It lives in `src/lib/` rather than beside the encoder so that the client
 * could read it too, though in practice the player builds its quality menu from the
 * manifest instead: what a viewer can pick has to be what was actually produced, and a
 * source smaller than the top rungs produces fewer of them.
 *
 * Rungs are measured on the **short edge**, not on height. A portrait phone video is
 * 1080 wide and 1920 tall, and laddering it by height would "downscale" it to 1080p —
 * i.e. not at all — and then upscale every rung below.
 */

/**
 * One AAC stream is muxed once and shared by every rendition, so its bitrate is part of
 * every rung's advertised bandwidth. Mapping audio per rendition instead would triple
 * the audio bytes in every variant, which is a mistake the argv test pins explicitly.
 */
export const AUDIO_KBPS = 128

export type LadderRung = {
  /** Short edge in pixels — 720 means "720p" for landscape, 720 wide for portrait. */
  height: number
  /** Video bitrate target. Audio is added on top; see `declaredBandwidthBps`. */
  videoKbps: number
}

/**
 * Ascending, and five rungs rather than three: the gaps between them are what adaptive
 * switching actually uses, and a ladder with only a few widely-spaced rungs forces the
 * player to make large, visible jumps on small changes in connection speed.
 *
 * The 240p rung exists for the genuinely bad connection. The engine only considers a
 * rendition it can carry with room to spare, so below roughly 640 kbps nothing on this
 * ladder qualifies and it falls back to the lowest rung available — and it is better for
 * that floor to be something a slow phone connection can actually sustain than for it to
 * be 360p and stall.
 */
export const RENDITION_LADDER: readonly LadderRung[] = [
  { height: 240, videoKbps: 400 },
  { height: 360, videoKbps: 800 },
  { height: 480, videoKbps: 1400 },
  { height: 720, videoKbps: 2800 },
  { height: 1080, videoKbps: 5000 },
] as const

/**
 * What a manifest advertises for this rung, in bits per second — video plus the shared
 * audio stream. This is the figure the player's selector compares against, so it is also
 * the figure the preset table has to be reasoned about in.
 */
export function declaredBandwidthBps(rung: LadderRung): number {
  return (rung.videoKbps + AUDIO_KBPS) * 1000
}

/**
 * The rungs to encode for a source whose short edge is `shortEdge`.
 *
 * Never upscales: spending CPU and bytes to produce something larger than — and visibly
 * worse than — the source is the one thing a ladder must not do. A source below the
 * lowest rung therefore gets exactly one rung at its own size rather than an empty
 * ladder, which would be an ffmpeg command with no outputs.
 */
export function ladderForShortEdge(shortEdge: number): LadderRung[] {
  if (!Number.isFinite(shortEdge) || shortEdge <= 0) return []

  const fits = RENDITION_LADDER.filter((rung) => rung.height <= shortEdge)
  if (fits.length > 0) return fits.map((rung) => ({ ...rung }))

  // Smaller than every rung. Encode it once at its own size, borrowing the lowest rung's
  // bitrate — which is generous for something this small, and generous is the safe
  // direction: the alternative is a visibly worse copy of an already-small video.
  return [{ height: evenDimension(shortEdge), videoKbps: RENDITION_LADDER[0].videoKbps }]
}

/**
 * Round down to an even number. H.264 with 4:2:0 chroma cannot encode an odd dimension,
 * so a 1919x1081 source breaks without this. The scale filter uses `-2` for the computed
 * axis for the same reason; this covers the axis we state outright.
 */
export function evenDimension(value: number): number {
  const floored = Math.floor(value)
  return floored % 2 === 0 ? floored : floored - 1
}
