/**
 * Running ffmpeg and ffprobe: the impure half of the transcode, kept apart from
 * `transcode-plan.ts` so that everything decidable stays testable without either binary
 * installed.
 *
 * Relative, `.ts`-suffixed imports throughout, because `scripts/transcode-one.ts` and
 * `scripts/transcode-worker.ts` load this under plain `node --experimental-strip-types`.
 *
 * Both binaries are spawned with an argv array and **never through a shell**. An uploaded
 * file's name reaches the temp path, so a shell here would be a real command injection
 * rather than a theoretical one — `safeFileName` narrows the name, and the absent shell is
 * what makes that narrowing sufficient.
 */
import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import {
  buildProbeArgs,
  buildTranscodeArgs,
  parseFrameRate,
  type ProbeResult,
} from './transcode-plan.ts'

/**
 * Read lazily rather than at module load, so an app with no ffmpeg still boots and only
 * transcoding fails — the same discipline `stripe.ts` applies to its own environment.
 */
function ffmpegPath(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg'
}

function ffprobePath(): string {
  return process.env.FFPROBE_PATH || 'ffprobe'
}

/** How much of ffmpeg's output is kept to explain a failure. */
const STDERR_TAIL_LINES = 40

export class FfmpegMissingError extends Error {}

type RunResult = { stdout: string; stderr: string }

/**
 * Spawn a binary and wait for it, collecting both streams.
 *
 * A missing binary arrives as an `ENOENT` on the process object rather than as a non-zero
 * exit, and it needs to be distinguishable: "ffmpeg is not installed" is a deployment fact
 * the worker should report once and then stay quiet about, whereas "ffmpeg rejected this
 * file" is a per-video failure worth retrying and recording.
 */
function run(bin: string, args: string[], signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // `-nostdin` is in the argv too, but an inherited stdin can still leave a child waiting
    // on a terminal that will never answer; ignoring it here closes that off entirely.
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], signal })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
      // Unbounded output on a long encode would otherwise grow without limit in a process
      // that is meant to keep running.
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000)
    })

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new FfmpegMissingError(`${bin} is not installed or not on PATH`))
        return
      }
      reject(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const tail = stderr.trim().split('\n').slice(-STDERR_TAIL_LINES).join('\n')
      reject(new Error(`${bin} exited ${code}: ${tail}`))
    })
  })
}

/**
 * Whether ffmpeg and ffprobe are both usable here.
 *
 * Checked once at worker startup: the development machine this is written on has neither,
 * and a worker that threw on every poll would fill the log and make `npm run dev` unusable
 * for everyone not working on video.
 */
export async function hasFfmpeg(): Promise<boolean> {
  try {
    await run(ffmpegPath(), ['-version'])
    await run(ffprobePath(), ['-version'])
    return true
  } catch {
    return false
  }
}

type ProbeStream = {
  codec_type?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  tags?: Record<string, string>
  side_data_list?: Array<{ rotation?: number }>
}

type ProbeJson = {
  streams?: ProbeStream[]
  format?: { duration?: string }
}

/**
 * Rotation in degrees, from either of the two places containers record it.
 *
 * A phone shoots portrait by recording a landscape stream and tagging it with a quarter
 * turn. ffmpeg applies that on decode, so a ladder built from the untouched `width` and
 * `height` describes a video nobody will ever see — every rung comes out letterboxed or
 * upscaled. Newer files carry it in the display-matrix side data, older ones in a `rotate`
 * tag, and plenty carry neither.
 */
function rotationOf(stream: ProbeStream): number {
  const fromSideData = stream.side_data_list?.find((entry) => entry.rotation !== undefined)
  if (fromSideData?.rotation !== undefined) return Number(fromSideData.rotation) || 0

  const tagged = stream.tags?.rotate
  return tagged === undefined ? 0 : Number(tagged) || 0
}

/**
 * Inspect a source file: what the ladder is built from, and what the argv is built from.
 *
 * Also the only honest source of `durationSeconds`. `createVideo` reads that off the upload
 * form, where the browser measured it — believable, but not something the server has any
 * reason to trust, and free to correct here because the file has to be opened anyway.
 */
export async function probeSource(filePath: string, signal?: AbortSignal): Promise<ProbeResult> {
  const { stdout } = await run(ffprobePath(), buildProbeArgs(filePath), signal)

  let parsed: ProbeJson
  try {
    parsed = JSON.parse(stdout) as ProbeJson
  } catch {
    throw new Error('ffprobe returned output that is not JSON')
  }

  const streams = parsed.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  if (!video || !video.width || !video.height) {
    throw new Error('No decodable video stream in this file')
  }

  const duration = Number(parsed.format?.duration)

  return {
    width: video.width,
    height: video.height,
    rotation: rotationOf(video),
    fps: parseFrameRate(video.avg_frame_rate || video.r_frame_rate),
    durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
    // Asked rather than assumed. A screen recording with no audio track makes an
    // unconditional `-map 0:a:0` fail before a single frame is written, and it is by some
    // distance the most common way a real upload kills an encode.
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  }
}

export type TranscodeOutput = {
  /** File name of the HLS master playlist, found rather than assumed. */
  hlsMaster: string
  /** File name of the DASH manifest. */
  dashManifest: string
  /** Every file ffmpeg wrote, for uploading. */
  files: string[]
}

/** ffmpeg's own name for the manifest, which is the one thing about the output we choose. */
const DASH_MANIFEST = 'manifest.mpd'

/**
 * Identify the HLS master among the playlists ffmpeg wrote.
 *
 * The master is the one listing the variants, which is what `#EXT-X-STREAM-INF` marks. It
 * is found by reading rather than by name because ffmpeg's DASH muxer has spelled the
 * per-variant playlists differently across versions (`media_0.m3u8`, `stream_0.m3u8`), and
 * a hardcoded pattern would work until the day the base image updated.
 */
async function findHlsMaster(outputDir: string, candidates: string[]): Promise<string> {
  const playlists = candidates.filter((name) => name.endsWith('.m3u8'))

  for (const name of playlists) {
    const text = await readFile(`${outputDir}/${name}`, 'utf8')
    if (text.includes('#EXT-X-STREAM-INF')) return name
  }

  throw new Error(
    `ffmpeg produced no HLS master playlist (looked in: ${playlists.join(', ') || 'nothing'})`,
  )
}

/**
 * Encode the ladder and package it as HLS and DASH in one pass.
 *
 * The DASH muxer emits the HLS playlists alongside its own manifest, so both protocols come
 * out of a single encode describing the same segments. Two muxers would double the CPU and
 * the stored bytes for output that plays identically.
 *
 * `signal` is how the worker aborts when it loses its lease: another worker has taken the
 * job over by then, so finishing would mean two processes writing one result.
 */
export async function runTranscode(input: {
  sourcePath: string
  outputDir: string
  probe: ProbeResult
  signal?: AbortSignal
}): Promise<TranscodeOutput> {
  const args = buildTranscodeArgs({
    sourcePath: input.sourcePath,
    outputDir: input.outputDir,
    probe: input.probe,
  })

  // An empty argv means the source yielded no ladder at all. Running ffmpeg with no outputs
  // would fail confusingly; this is a video to skip, and the caller is told plainly.
  if (args.length === 0) throw new Error('This source produced no encodable renditions')

  await run(ffmpegPath(), args, input.signal)

  const files = await readdir(input.outputDir)
  if (files.length === 0) throw new Error('ffmpeg exited cleanly but wrote nothing')

  return {
    hlsMaster: await findHlsMaster(input.outputDir, files),
    dashManifest: DASH_MANIFEST,
    files,
  }
}
