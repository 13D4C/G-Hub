/**
 * Transcode one specific video, now, ignoring the queue.
 *
 * Run: npm run transcode-one -- --video 65f0c0ffee0123456789abcd
 * PowerShell: npm run transcode-one '--' --video 65f0c0ffee0123456789abcd
 *
 * The id is an argument rather than something that can be baked into a script entry, so this
 * one needs the quoted separator in PowerShell — a bare `--` is consumed by `npm.ps1`.
 *
 * The queue is the right way to get work done and the wrong way to debug a single failure:
 * a video that keeps failing has already spent its attempts, its backoff pushes the next try
 * minutes away, and the worker moves on to something else while you are reading the error.
 * This claims the named video regardless of its state and runs it in the foreground with
 * ffmpeg's own complaint on screen.
 *
 * It writes through exactly the same functions the worker uses, so a video fixed this way is
 * indistinguishable afterwards from one the worker handled — there is no second code path
 * here that could drift from the real one.
 */
import mongoose from 'mongoose'
import { randomUUID } from 'node:crypto'
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import { VideoModel } from '../src/server/db/models/video.ts'
import {
  completeTranscode,
  failTranscode,
  makeWorkerId,
  skipTranscode,
} from '../src/server/lib/transcode-queue.ts'
import { transcodeVideo, TranscodeSkipped } from '../src/server/lib/transcode-runner.ts'
import { MAX_ATTEMPTS } from '../src/server/lib/transcode-plan.ts'

const videoId = process.argv.find((a) => a.startsWith('--video='))?.slice('--video='.length)
  ?? process.argv[process.argv.indexOf('--video') + 1]

async function main() {
  if (!videoId || videoId.startsWith('--')) {
    console.error("Usage: npm run transcode-one -- --video <videoId>   (PowerShell: '--' in quotes)")
    process.exitCode = 1
    return
  }

  await connectToDatabase()

  const workerId = makeWorkerId()

  // A targeted claim: same fields the queue's claim sets, but matched on this id alone so a
  // `failed` or `skipped` video can be retried without first being swept back to `pending`.
  // `attempts` is reset rather than incremented — this is a deliberate retry by a person, not
  // another automatic go at something that has been failing on its own.
  const claimed = await VideoModel.findOneAndUpdate(
    { _id: videoId },
    {
      $set: {
        'transcode.status': 'processing',
        'transcode.workerId': workerId,
        'transcode.prefix': randomUUID(),
        'transcode.attempts': 1,
        'transcode.nextAttemptAt': new Date(),
        'transcode.startedAt': new Date(),
        'transcode.error': '',
      },
    },
    { returnDocument: 'after' },
  )
    .select('url title transcode.prefix')
    .lean()

  if (!claimed) {
    console.error(`No video with id ${videoId}`)
    process.exitCode = 1
    return
  }

  console.log(`Transcoding "${claimed.title}" (${videoId})`)
  console.log(`  source: ${claimed.url}`)

  try {
    const result = await transcodeVideo({
      videoId,
      sourceUrl: claimed.url,
      prefix: claimed.transcode?.prefix ?? '',
    })

    await completeTranscode(videoId, workerId, {
      hlsUrl: result.hlsUrl,
      dashUrl: result.dashUrl,
      renditions: result.renditions,
      sourceWidth: result.probe.width,
      sourceHeight: result.probe.height,
      durationSeconds: result.probe.durationSeconds,
    })

    console.log(`\nReady — ${result.renditions.length} renditions, ${result.uploaded} objects.`)
    console.log(`  source:    ${result.probe.width}x${result.probe.height} @ ${result.probe.fps.toFixed(2)}fps, audio: ${result.probe.hasAudio}`)
    console.log(`  renditions: ${result.renditions.map((r) => `${r.height}p`).join(', ')}`)
    console.log(`  HLS:  ${result.hlsUrl}`)
    console.log(`  DASH: ${result.dashUrl}`)
  } catch (error) {
    if (error instanceof TranscodeSkipped) {
      await skipTranscode(videoId, workerId, error.message)
      console.warn(`Skipped: ${error.message}`)
      return
    }

    await failTranscode(videoId, workerId, MAX_ATTEMPTS, error)
    console.error('\nFailed:', error)
    process.exitCode = 1
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => mongoose.disconnect())
