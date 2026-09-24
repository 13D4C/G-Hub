/**
 * Everything about a transcode that can be decided without running anything: which rungs
 * to encode, the exact ffmpeg argv, the content type each output file needs, and the
 * queue's retry arithmetic.
 *
 * Only other import-free modules may be imported here — `scripts/test-transcode-plan.ts`
 * loads this under plain `node --experimental-strip-types`, which resolves neither
 * tsconfig paths nor extensionless specifiers. That constraint is the point rather than a
 * nuisance: building the command as a `string[]` here means the whole thing is verifiable
 * on a machine with no ffmpeg installed, which is the machine it is being written on.
 *
 * The argv is returned as an array and must be handed to `spawn(bin, argv)` **without a
 * shell**. An uploaded file's name reaches both the storage key and the temp path, so a
 * shell here would be a genuine command injection; `safeFileName` narrows the name and the
 * absent shell is what makes that sufficient.
 */
import {
  AUDIO_KBPS,
  evenDimension,
  ladderForShortEdge,
  type LadderRung,
} from '../../lib/rendition-ladder.ts'

/**
 * Segment length. Six seconds is Apple's recommendation for video on demand, and it is
 * also about a third fewer objects than four seconds would be — a one-hour video is
 * roughly 2,400 segment objects at this length rather than 3,600, and object count is what
 * the storage layer actually feels.
 */
export const SEGMENT_SECONDS = 6

/** Frame rate assumed when the container reports a broken or missing one. */
export const DEFAULT_FPS = 30

/**
 * How many times a video may be claimed before it is given up on. Counted on claim rather
 * than on failure, so a file that reliably kills the worker process stops after three
 * tries instead of crash-looping forever.
 */
export const MAX_ATTEMPTS = 3

/**
 * How long a claim is held before another worker may take the job. Short, with the worker
 * renewing it while ffmpeg runs: a container killed mid-encode is then re-claimable in
 * minutes rather than hours, and nothing has to notice it died.
 */
export const LEASE_MS = 5 * 60_000

export type ProbeResult = {
  /** Raw stream dimensions, before rotation is applied. */
  width: number
  height: number
  /** Display rotation in degrees, as the container reports it. */
  rotation: number
  fps: number
  durationSeconds: number
  /** False for a source with no audio track at all — a screen recording, typically. */
  hasAudio: boolean
}

/**
 * Parse ffprobe's rational frame rate (`"30000/1001"`, `"25/1"`).
 *
 * Falls back rather than throwing: a broken header reports `"0/0"`, and refusing to encode
 * a playable file over a frame-rate string would be a worse outcome than assuming 30. The
 * figure only sets the keyframe interval, and being slightly wrong there costs segment
 * alignment precision, not correctness.
 */
export function parseFrameRate(rate: string | null | undefined): number {
  if (typeof rate !== 'string') return DEFAULT_FPS

  const [numerator, denominator] = rate.split('/')
  const n = Number(numerator)
  const d = denominator === undefined ? 1 : Number(denominator)

  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n <= 0) return DEFAULT_FPS
  return n / d
}

/**
 * The dimensions a viewer actually sees, which is what the ladder has to be built from.
 *
 * A phone shoots portrait by recording a 1920x1080 stream and tagging it with a quarter
 * turn; ffmpeg applies that on decode. Laddering the raw numbers would treat it as
 * landscape, so every rung would be produced letterboxed or upscaled.
 */
export function displayDimensions(probe: Pick<ProbeResult, 'width' | 'height' | 'rotation'>): {
  width: number
  height: number
} {
  const turned = Math.abs(Math.round(probe.rotation)) % 180 === 90
  return turned
    ? { width: probe.height, height: probe.width }
    : { width: probe.width, height: probe.height }
}

/**
 * Frames between keyframes.
 *
 * Computed from the probed frame rate and never hardcoded, because every rendition has to
 * cut its keyframes at the same timestamps: if they drift, segments stop lining up across
 * the ladder and the player cannot switch cleanly. The symptom is not an error — it is a
 * stall at the moment a viewer's connection changes, which is precisely the moment this
 * whole feature exists to handle.
 */
export function gopFramesFor(fps: number, segmentSeconds: number = SEGMENT_SECONDS): number {
  const rounded = Math.round(Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS)
  return Math.max(1, rounded * segmentSeconds)
}

/** Backoff before a failed video may be claimed again: 1 min, 5 min, 25 min, capped at 1h. */
export function backoffMsFor(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts))
  return Math.min(60 * 60_000, 60_000 * 5 ** (n - 1))
}

/**
 * Reduce an uploaded file's name to something safe to use as a path segment.
 *
 * `createVideo` has always interpolated `file.name` straight into the storage key, so a
 * name containing a slash could write outside its own prefix. Path separators, leading dots
 * and dashes, and runs of dots are all removed, so nothing becomes `..`, a dotfile, or
 * something a later tool would read as a flag.
 *
 * Letters are kept in **any** script, not just ASCII. The first version of this allowed
 * `[A-Za-z0-9._-]` and nothing else, which turned a Thai filename into the empty string —
 * `ความรัก.mp4` came out as `mp4`, so every non-Latin upload landed under an anonymous key
 * that said nothing about what it held. Unicode letters and digits introduce none of the
 * risks above: S3 keys are UTF-8, `publicUrl` percent-encodes each segment for the browser,
 * and the name never reaches a filesystem path — the worker stages the source under a fixed
 * `source` filename.
 *
 * Combining marks (`\p{M}`) are kept alongside letters, which is not a detail: Thai writes
 * its vowels and tones as marks, so allowing only letters turned `ความรัก` into `ความร-ก`.
 * The same omission would mangle Arabic, Hebrew and every Indic script.
 *
 * The extension is matched and reattached separately so it survives a stem that sanitises
 * away to nothing, and so a name like `../../etc/passwd` cannot have its path read as one.
 */
export function safeFileName(name: string): string {
  const raw = String(name ?? '')

  // Strictly a short alphanumeric run at the very end, so a slash-bearing path cannot be
  // mistaken for an extension.
  const extMatch = raw.match(/\.([A-Za-z0-9]{1,12})$/)
  const ext = extMatch ? extMatch[1].toLowerCase() : ''
  const stem = extMatch ? raw.slice(0, raw.length - ext.length - 1) : raw

  const safeStem =
    stem
      .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[.-]+/, '')
      .replace(/[.-]+$/, '')
      .slice(0, 100) || 'upload'

  return ext ? `${safeStem}.${ext}` : safeStem
}

/**
 * What each output file has to be served as. SeaweedFS does not guess, and an object
 * stored without a content type comes back as `application/octet-stream` — which the
 * adaptive engine tolerates but Safari's native playback rejects, so the failure would
 * show up on exactly one platform.
 *
 * `.m4s` is served as `video/mp4` rather than the registered `video/iso.segment`: the
 * engine ignores segment content types entirely, some players are particular about
 * `iso.segment`, and nothing objects to `video/mp4`.
 */
export function contentTypeFor(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl'
  if (lower.endsWith('.mpd')) return 'application/dash+xml'
  if (lower.endsWith('.m4s') || lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  return 'application/octet-stream'
}

/** The ladder this source should be encoded at, measured on its displayed short edge. */
export function ladderForProbe(probe: ProbeResult): LadderRung[] {
  const { width, height } = displayDimensions(probe)
  return ladderForShortEdge(Math.min(width, height))
}

export type TranscodeArgsInput = {
  sourcePath: string
  /** Directory ffmpeg writes the manifest and every segment into. */
  outputDir: string
  probe: ProbeResult
}

/**
 * The single ffmpeg invocation that produces HLS and DASH together.
 *
 * The DASH muxer is asked to emit the HLS playlists as well, so one encode yields
 * `manifest.mpd` and `master.m3u8` describing the *same* CMAF segments. Running two
 * muxers instead would double both the CPU and the stored bytes, and CPU is the scarce
 * resource on a box that is also serving the site.
 *
 * Returns an empty array for a source with no usable ladder, which the caller must treat
 * as "skip this video" rather than running ffmpeg with no outputs.
 */
export function buildTranscodeArgs(input: TranscodeArgsInput): string[] {
  const { sourcePath, outputDir, probe } = input
  const rungs = ladderForProbe(probe)
  if (rungs.length === 0) return []

  const { width, height } = displayDimensions(probe)
  const portrait = width < height
  const gop = gopFramesFor(probe.fps)

  // One split per rung feeding one scale filter each. The computed axis is left to ffmpeg
  // with -2, which rounds to an even number — H.264's 4:2:0 chroma requires it, and a
  // 1919x1081 source fails without it. The stated axis is the short edge, so portrait and
  // landscape swap which axis that is.
  const labels = rungs.map((_, i) => `o${i}`)
  const splits = rungs.map((_, i) => `[v${i}]`).join('')
  const scales = rungs
    .map((rung, i) => {
      const target = evenDimension(rung.height)
      const geometry = portrait ? `w=${target}:h=-2` : `w=-2:h=${target}`
      return `[v${i}]scale=${geometry}[${labels[i]}]`
    })
    .join(';')

  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'warning',
    '-y',
    '-i',
    sourcePath,
    '-filter_complex',
    `[0:v]split=${rungs.length}${splits};${scales}`,
  ]

  rungs.forEach((rung, i) => {
    args.push(
      '-map',
      `[${labels[i]}]`,
      `-c:v:${i}`,
      'libx264',
      `-b:v:${i}`,
      `${rung.videoKbps}k`,
      // A ceiling a little above the target with a two-second buffer: enough to let a busy
      // scene spend, not enough to overshoot what the rung advertises in the manifest.
      `-maxrate:v:${i}`,
      `${Math.round(rung.videoKbps * 1.07)}k`,
      `-bufsize:v:${i}`,
      `${rung.videoKbps * 2}k`,
    )
  })

  // Mapped exactly once, not once per rung: every rendition shares this one stream, and
  // mapping it per rung would put the audio bytes into each variant's advertised bandwidth.
  if (probe.hasAudio) {
    args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-ac', '2', '-ar', '48000')
  }

  args.push(
    '-preset',
    'veryfast',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    // A variable-rate source (screen recordings, most commonly) otherwise produces segments
    // of drifting length, which makes the manifest's advertised target duration a lie and
    // stalls players at segment boundaries.
    '-fps_mode',
    'cfr',
    '-g',
    String(gop),
    '-keyint_min',
    String(gop),
    // The same instruction in two spellings, deliberately. Newer ffmpeg deprecates
    // -sc_threshold for libx264 and older builds ignore the x264-params spelling, and a
    // single scene cut that only one rung inserts breaks segment alignment silently.
    '-sc_threshold',
    '0',
    '-x264-params',
    'scenecut=0:open-gop=0',
    // Bounded so one encode cannot take every core of a container that is also serving
    // requests.
    '-threads',
    '2',
    '-filter_threads',
    '2',
  )

  args.push(
    '-f',
    'dash',
    '-seg_duration',
    String(SEGMENT_SECONDS),
    '-use_template',
    '1',
    '-use_timeline',
    '0',
    '-dash_segment_type',
    'mp4',
    // The DASH muxer emits the HLS playlists too, over the same segments.
    '-hls_playlist',
    '1',
    // Pins the master playlist's name. The per-variant playlists are deliberately not named
    // here: ffmpeg has spelled them differently across versions, so the worker finds them by
    // reading which .m3u8 carries the stream-inf tag rather than assuming a pattern.
    '-hls_master_name',
    'master.m3u8',
    // One argv element containing spaces, which is safe only because nothing goes through a
    // shell. It must agree with the audio mapping above: naming an audio adaptation set that
    // no stream was mapped into makes ffmpeg exit before it encodes anything.
    '-adaptation_sets',
    probe.hasAudio ? 'id=0,streams=v id=1,streams=a' : 'id=0,streams=v',
    '-init_seg_name',
    'init-$RepresentationID$.m4s',
    '-media_seg_name',
    'chunk-$RepresentationID$-$Number%05d$.m4s',
    `${outputDir}/manifest.mpd`,
  )

  return args
}

/** ffprobe's side of the same pairing: one JSON dump of the container and its streams. */
export function buildProbeArgs(sourcePath: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', sourcePath]
}
