/**
 * The transcode worker loop, shared by the standalone script and the in-process plugin.
 *
 * Relative, `.ts`-suffixed imports, because `scripts/transcode-worker.ts` loads this under
 * plain `node --experimental-strip-types` while Vite bundles the same module for the app.
 *
 * Running both at once is deliberately safe: claiming is a single atomic document update, so
 * an extra worker is extra throughput rather than a hazard. That is what makes it reasonable
 * to ship the in-process loop on by default and still keep a script for draining a backlog
 * or debugging by hand.
 */
import {
  claimNextVideo,
  completeTranscode,
  failTranscode,
  leaseMs,
  makeWorkerId,
  renewClaim,
  retryBaseMs,
  skipTranscode,
  type ClaimedVideo,
} from './transcode-queue.ts'
import { connectToDatabase } from '../db/mongoose.ts'
import { hasFfmpeg } from './ffmpeg.ts'
import { backoffMsFor, heartbeatMsFor } from './transcode-plan.ts'
import { transcodeVideo, TranscodeSkipped } from './transcode-runner.ts'


/** Idle poll interval, jittered so several workers do not wake together forever. */
const POLL_MS = 15_000

function nextPollDelay(): number {
  return POLL_MS + Math.floor(Math.random() * 5_000)
}

function concurrency(): number {
  const configured = Number(process.env.TRANSCODE_CONCURRENCY)
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 1
}

/**
 * Encode one claimed video and record how it went.
 *
 * The heartbeat is the interesting part. It renews the lease while ffmpeg runs, and when the
 * renewal reports the claim is gone it aborts the encode — another worker has taken the job
 * over by then, so continuing would mean two processes writing one result. Every write below
 * is additionally guarded on the worker id, so even a lost race writes nothing.
 */
async function processClaimed(video: ClaimedVideo, workerId: string): Promise<void> {
  const controller = new AbortController()

  // The interval is derived from the lease rather than fixed, so shortening the lease cannot
  // leave the heartbeat slower than it — which would make every long encode abort itself.
  const heartbeat = setInterval(() => {
    renewClaim(video.id, workerId)
      .then((held) => {
        if (!held) {
          console.warn(`[transcode] lease lost for ${video.id}, abandoning this attempt`)
          controller.abort()
        }
      })
      .catch(() => {
        // A failed renewal is not itself proof the lease is gone — the database may simply
        // be briefly unreachable. Let the encode continue; if the lease really has lapsed,
        // the guarded writes at the end refuse it anyway.
      })
  }, heartbeatMsFor(leaseMs()))

  try {
    const result = await transcodeVideo({
      videoId: video.id,
      sourceUrl: video.url,
      prefix: video.prefix,
      signal: controller.signal,
    })

    if (controller.signal.aborted) return

    const wrote = await completeTranscode(video.id, workerId, {
      hlsUrl: result.hlsUrl,
      dashUrl: result.dashUrl,
      renditions: result.renditions,
      sourceWidth: result.probe.width,
      sourceHeight: result.probe.height,
      durationSeconds: result.probe.durationSeconds,
    })

    console.log(
      wrote
        ? `[transcode] ${video.id} ready — ${result.renditions.length} renditions, ${result.uploaded} objects`
        : `[transcode] ${video.id} finished but the claim had moved on; nothing written`,
    )
  } catch (error) {
    // An abort is this worker standing down, not a failure of the video. Writing a failure
    // here would spend an attempt on behalf of the worker that now owns the job.
    if (controller.signal.aborted) return

    if (error instanceof TranscodeSkipped) {
      await skipTranscode(video.id, workerId, error.message)
      console.warn(`[transcode] ${video.id} skipped — ${error.message}`)
      return
    }

    await failTranscode(video.id, workerId, video.attempts, error)
    console.error(`[transcode] ${video.id} failed on attempt ${video.attempts}:`, error)
  } finally {
    clearInterval(heartbeat)
  }
}

/** Claim and encode a single video. Returns false when the queue is empty. */
export async function transcodeNext(workerId: string): Promise<boolean> {
  const video = await claimNextVideo(workerId)
  if (!video) return false

  console.log(`[transcode] claimed ${video.id} (attempt ${video.attempts})`)
  await processClaimed(video, workerId)
  return true
}

/** Keep claiming until the queue is empty. What `--once` runs, and what each loop tick does. */
export async function drainQueue(workerId: string): Promise<number> {
  let done = 0
  while (await transcodeNext(workerId)) {
    done += 1
  }
  return done
}

export type WorkerHandle = { stop: () => void }

/**
 * Start polling for work.
 *
 * Returns a handle rather than running forever, so the in-process plugin can stop scheduling
 * on shutdown. A container being redeployed otherwise leaves an ffmpeg child holding the
 * process open past the stop timeout, and gets killed harder than it needed to be.
 *
 * Self-scheduling `setTimeout` rather than `setInterval`: a tick that outlasts the interval
 * would otherwise stack, and these ticks can last as long as an encode.
 */
export function startTranscodeWorker(): WorkerHandle {
  const workerId = makeWorkerId()
  let stopped = false
  let timer: NodeJS.Timeout | null = null

  async function tick(): Promise<void> {
    if (stopped) return

    try {
      const lanes = concurrency()
      await Promise.all(Array.from({ length: lanes }, () => drainQueue(workerId)))
    } catch (error) {
      // Never let a tick's failure stop the loop: an unreachable database now would
      // otherwise mean no transcoding until someone restarts the process.
      console.error('[transcode] worker tick failed:', error)
    }

    if (!stopped) timer = setTimeout(tick, nextPollDelay())
  }

  void (async () => {
    // The app boots this plugin alongside the one that opens the database, and that one
    // does not await its own connection — so without this the first tick can beat it and
    // log a failure that looks alarming and means nothing. Idempotent and cached, so the
    // standalone script calling it first costs nothing.
    try {
      await connectToDatabase()
    } catch {
      // Leave it to the loop: the database being briefly unreachable at boot is not a
      // reason to never transcode again, and every tick retries.
    }

    // Checked once, before anything else. Neither binary exists on a typical development
    // machine, and a worker that threw on every poll would bury the dev server's output for
    // everyone not working on video.
    if (!(await hasFfmpeg())) {
      console.warn(
        '[transcode] ffmpeg/ffprobe not found — transcoding is off. Videos still play from their original upload. See .env.example (FFMPEG_PATH).',
      )
      return
    }

    // The timings in force, because they are configurable and a slow retry is otherwise
    // indistinguishable from a stuck one.
    const lease = leaseMs()
    const retry = retryBaseMs()
    console.log(
      `[transcode] worker ${workerId} started — lease ${lease / 1000}s, renewed every ` +
        `${heartbeatMsFor(lease) / 1000}s; failed videos retry after ${retry / 1000}s, ` +
        `then ${backoffMsFor(2, retry) / 1000}s`,
    )
    void tick()
  })()

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
