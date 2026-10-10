/**
 * One video, end to end: fetch the source, probe it, encode the ladder, and upload the
 * result. Everything between claiming a job and recording that it finished.
 *
 * Relative, `.ts`-suffixed imports, because the worker scripts load this under plain `node
 * --experimental-strip-types`.
 *
 * Deliberately knows nothing about the queue. It takes a video id, a source url and an
 * output prefix, and returns what it produced — which is what lets `scripts/transcode-one.ts`
 * run it against a single video with no claim, no lease and no polling when something needs
 * debugging.
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { probeSource, runTranscode } from './ffmpeg.ts'
import { contentTypeFor, ladderForProbe, type ProbeResult } from './transcode-plan.ts'
import { declaredBandwidthBps } from '../../lib/rendition-ladder.ts'
import {
  getObjectStream,
  keyFromPublicUrl,
  publicUrl,
  uploadFile,
} from '../storage/seaweed.ts'

export type RenditionSummary = { width: number; height: number; bitrateKbps: number }

export type TranscodeResult = {
  hlsUrl: string
  dashUrl: string
  renditions: RenditionSummary[]
  probe: ProbeResult
  /** How many objects were uploaded, for the worker's log line. */
  uploaded: number
}

/** Sources larger than this are refused rather than staged onto the container's disk. */
function maxSourceBytes(): number {
  const configured = Number(process.env.TRANSCODE_MAX_SOURCE_MB)
  const megabytes = Number.isFinite(configured) && configured > 0 ? configured : 2048
  return megabytes * 1024 * 1024
}

function tempRoot(): string {
  return process.env.TRANSCODE_TMP_DIR || tmpdir()
}

/** Raised for a source this pipeline will not attempt, as opposed to one it failed on. */
export class TranscodeSkipped extends Error {}

/**
 * Progress, written as each stage begins.
 *
 * Worth the noise because the alternative is worse: a claim line followed by several
 * minutes of complete silence, which looks identical whether the encode is working, the
 * source download has stalled, or ffmpeg has wedged. Each line names the stage that is
 * *starting*, so the last line printed is always where the time is going.
 */
function stage(videoId: string, message: string): void {
  console.log(`[transcode] ${videoId} ${message}`)
}

/**
 * How many objects to upload at once.
 *
 * A long video is thousands of segments, so uploading them one after another is needlessly
 * slow, and uploading them all at once would open thousands of sockets and hold every
 * segment in memory together. A small fixed width is the whole of the tuning this needs.
 */
const UPLOAD_CONCURRENCY = 6

/**
 * How many times one object is attempted before the whole upload gives up.
 *
 * A long video is thousands of objects, and without this a single transient refusal on any
 * one of them throws away an encode that may have taken ten minutes — and spends one of the
 * job's three attempts doing it. Three tries with a short backoff costs nothing when the
 * storage is healthy, and is the difference between surviving a hiccup and not.
 *
 * It deliberately does not paper over a storage layer that is refusing everything: after the
 * retries the error still propagates, and the job still fails with the reason recorded.
 */
const UPLOAD_ATTEMPTS = 3

async function uploadOne(key: string, filePath: string, contentType: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await uploadFile({ key, filePath, contentType })
      return
    } catch (error) {
      if (attempt >= UPLOAD_ATTEMPTS) throw error
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt))
    }
  }
}

async function uploadAll(files: string[], outputDir: string, prefix: string): Promise<void> {
  let next = 0

  async function worker(): Promise<void> {
    while (next < files.length) {
      const name = files[next]
      next += 1
      // Content type is set per file rather than once for the batch: SeaweedFS does not
      // guess, and a manifest served as `application/octet-stream` is rejected by Safari's
      // native playback while the segments beside it would have been fine.
      await uploadOne(`${prefix}${name}`, join(outputDir, name), contentTypeFor(name))
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, () => worker()),
  )
}

export type TranscodeJobInput = {
  videoId: string
  /** The stored original — a public SeaweedFS url, as `video.url` holds it. */
  sourceUrl: string
  /** The random per-attempt path segment the output is written under. */
  prefix: string
  signal?: AbortSignal
}

/**
 * Transcode one video and upload the result.
 *
 * Everything is staged in a temp directory that is removed in a `finally`, including on the
 * abort path — a worker that loses its lease mid-encode must leave nothing behind, because
 * the container's writable layer is shared with everything else running on the host.
 */
export async function transcodeVideo(input: TranscodeJobInput): Promise<TranscodeResult> {
  const sourceKey = keyFromPublicUrl(input.sourceUrl)
  if (!sourceKey) {
    throw new TranscodeSkipped('Source url does not point at this bucket')
  }

  await mkdir(tempRoot(), { recursive: true })
  const workDir = await mkdtemp(join(tempRoot(), 'gh-transcode-'))
  const sourcePath = join(workDir, 'source')
  const outputDir = join(workDir, 'out')

  try {
    await mkdir(outputDir, { recursive: true })

    // Staged locally rather than read over HTTP by ffmpeg. An MP4 whose metadata sits at the
    // end of the file turns the first seek into a burst of range requests, and a read that
    // fails halfway through a long encode has no retry.
    stage(input.videoId, `downloading source ${sourceKey}`)
    const startedAt = Date.now()
    await pipeline(await getObjectStream(sourceKey), createWriteStream(sourcePath))

    const { size } = await stat(sourcePath)
    if (size > maxSourceBytes()) {
      throw new TranscodeSkipped(
        `Source is ${Math.round(size / 1024 / 1024)}MB, over the configured limit`,
      )
    }

    stage(input.videoId, `downloaded ${Math.round(size / 1024 / 1024)}MB, probing`)
    const probe = await probeSource(sourcePath, input.signal)
    const rungs = ladderForProbe(probe)
    if (rungs.length === 0) {
      throw new TranscodeSkipped('Source dimensions produced no encodable renditions')
    }

    // The line that matters most when something looks stuck: everything after it is one
    // ffmpeg process, which on a long video is minutes with nothing else to say.
    stage(
      input.videoId,
      `encoding ${rungs.length} renditions (${rungs.map((r) => `${r.height}p`).join(", ")}) ` +
        `from ${probe.width}x${probe.height} @${probe.fps.toFixed(2)}fps, ` +
        `${probe.durationSeconds}s, audio ${probe.hasAudio ? "yes" : "no"}`,
    )
    const encodeStartedAt = Date.now()
    const output = await runTranscode({ sourcePath, outputDir, probe, signal: input.signal })

    const keyPrefix = `videos/${input.videoId}/${input.prefix}/`
    stage(
      input.videoId,
      `encoded in ${Math.round((Date.now() - encodeStartedAt) / 1000)}s, ` +
        `uploading ${output.files.length} objects`,
    )
    await uploadAll(output.files, outputDir, keyPrefix)
    stage(input.videoId, `done in ${Math.round((Date.now() - startedAt) / 1000)}s total`)

    return {
      hlsUrl: publicUrl(`${keyPrefix}${output.hlsMaster}`),
      dashUrl: publicUrl(`${keyPrefix}${output.dashManifest}`),
      // Widths are what the ladder asked for on the short edge; the manifest carries the
      // exact figures and is what the player reads, so these are for reporting only.
      renditions: rungs.map((rung) => ({
        width: 0,
        height: rung.height,
        bitrateKbps: Math.round(declaredBandwidthBps(rung) / 1000),
      })),
      probe,
      uploaded: output.files.length,
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}
