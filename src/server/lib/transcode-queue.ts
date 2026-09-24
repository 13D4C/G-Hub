/**
 * The transcode queue: claiming a video, holding the claim, and recording how it ended.
 *
 * Relative, `.ts`-suffixed imports, because the worker scripts and the queue's own test load
 * this under plain `node --experimental-strip-types`.
 *
 * Mongo only — no ffmpeg, no storage. That separation is what lets the claim semantics be
 * tested against a real database on a machine with neither installed, which is where the
 * interesting failures live: two workers taking one job, a dead worker's job never coming
 * back, or a worker that lost its lease overwriting the result of the one that replaced it.
 *
 * There is no lock collection and no transaction. `findOneAndUpdate` is atomic per document,
 * so a racing pair of workers cannot both match-and-modify the same row — one gets the
 * document and the other moves on. That single primitive is the whole concurrency story.
 */
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { VideoModel } from '../db/models/video.ts'
import { backoffMsFor, LEASE_MS, MAX_ATTEMPTS } from './transcode-plan.ts'

/** The states a worker may take over: queued, or held by a lease that has run out. */
// `as const` matters here for the same reason it does in `entitlement.ts`: without it the
// literals widen to `string` and no longer satisfy Mongoose's typed filter for the enum.
const CLAIMABLE = ['pending', 'processing'] as const

export type ClaimedVideo = {
  id: string
  url: string
  prefix: string
  attempts: number
}

/**
 * Unique per process and per restart.
 *
 * The restart part matters: a worker that came back after being killed must not inherit the
 * identity of its own dead lease, or it could satisfy a guard meant to exclude it.
 */
export function makeWorkerId(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
}

/**
 * Take the oldest video whose lease or backoff has expired, or return null when there is
 * nothing to do.
 *
 * `processing` is in the match on purpose. A worker killed mid-encode leaves a row in that
 * state with a `nextAttemptAt` already in the past, so it is picked up again by whoever polls
 * next — no reaper, no cleanup pass, nothing to notice it died.
 *
 * `attempts` increments here rather than on failure for the same reason: a process that dies
 * before it can record anything still spends an attempt, so a file that reliably kills the
 * worker stops after `MAX_ATTEMPTS` instead of restarting the container forever.
 */
export async function claimNextVideo(workerId: string): Promise<ClaimedVideo | null> {
  const now = new Date()

  const claimed = await VideoModel.findOneAndUpdate(
    {
      'transcode.status': { $in: CLAIMABLE },
      'transcode.nextAttemptAt': { $lte: now },
      'transcode.attempts': { $lt: MAX_ATTEMPTS },
    },
    {
      $set: {
        'transcode.status': 'processing',
        'transcode.nextAttemptAt': new Date(now.getTime() + LEASE_MS),
        'transcode.workerId': workerId,
        // A fresh output path per attempt, so a retry cannot interleave its segments with
        // those of an attempt that died halfway. Random rather than derived from the video
        // id because these objects are public-read, and for a paywalled video an unguessable
        // key is what protects the bytes.
        'transcode.prefix': randomUUID(),
        'transcode.startedAt': now,
        'transcode.error': '',
      },
      $inc: { 'transcode.attempts': 1 },
    },
    { sort: { 'transcode.nextAttemptAt': 1 }, returnDocument: 'after' },
  )
    .select('url transcode.prefix transcode.attempts')
    .lean()

  if (!claimed) return null

  return {
    id: String(claimed._id),
    url: claimed.url,
    prefix: claimed.transcode?.prefix ?? '',
    attempts: claimed.transcode?.attempts ?? 1,
  }
}

/**
 * Push the lease out while the encode runs.
 *
 * Returns false when the claim is gone — the lease lapsed during a long pause and another
 * worker took the job, or an operator forced a retry. **The caller must stop immediately on
 * false**: killing its ffmpeg child, deleting its temp directory and writing nothing. Two
 * workers finishing the same job is the one outcome the guards below cannot undo, because
 * both would be writing plausible results.
 */
export async function renewClaim(videoId: string, workerId: string): Promise<boolean> {
  const result = await VideoModel.updateOne(
    { _id: videoId, 'transcode.workerId': workerId, 'transcode.status': 'processing' },
    { $set: { 'transcode.nextAttemptAt': new Date(Date.now() + LEASE_MS) } },
  )

  return result.matchedCount > 0
}

export type CompletedTranscode = {
  hlsUrl: string
  dashUrl: string
  renditions: Array<{ width: number; height: number; bitrateKbps: number }>
  sourceWidth: number
  sourceHeight: number
  /** Probed from the file, which is more trustworthy than what the upload form reported. */
  durationSeconds: number
}

/**
 * Record a finished transcode.
 *
 * Guarded on `workerId`, like every other write that ends a job: a worker whose lease expired
 * mid-encode must not be able to overwrite the result of the worker that replaced it.
 * Returns whether the write landed, so a worker that lost the race can say so rather than
 * logging a success it did not achieve.
 */
export async function completeTranscode(
  videoId: string,
  workerId: string,
  result: CompletedTranscode,
): Promise<boolean> {
  const update = await VideoModel.updateOne(
    { _id: videoId, 'transcode.workerId': workerId },
    {
      $set: {
        'transcode.status': 'ready',
        'transcode.hlsUrl': result.hlsUrl,
        'transcode.dashUrl': result.dashUrl,
        'transcode.renditions': result.renditions,
        'transcode.sourceWidth': result.sourceWidth,
        'transcode.sourceHeight': result.sourceHeight,
        'transcode.finishedAt': new Date(),
        'transcode.error': '',
        // Corrected from the probe. Until now this was whatever the uploader's browser
        // measured and the server took on trust.
        ...(result.durationSeconds > 0 ? { durationSeconds: result.durationSeconds } : {}),
      },
    },
  )

  return update.matchedCount > 0
}

/**
 * Record a failure, and decide whether to try again.
 *
 * Back to `pending` with a delay while attempts remain, `failed` once they are spent. Either
 * way the video keeps playing from its original upload, and nothing a viewer sees changes —
 * which is why there is no alerting here and no viewer-facing retry.
 */
export async function failTranscode(
  videoId: string,
  workerId: string,
  attempts: number,
  error: unknown,
): Promise<boolean> {
  const giveUp = attempts >= MAX_ATTEMPTS
  const message = error instanceof Error ? error.message : String(error)

  const update = await VideoModel.updateOne(
    { _id: videoId, 'transcode.workerId': workerId },
    {
      $set: {
        'transcode.status': giveUp ? 'failed' : 'pending',
        'transcode.nextAttemptAt': new Date(Date.now() + backoffMsFor(attempts)),
        'transcode.error': message.slice(0, 500),
        'transcode.finishedAt': giveUp ? new Date() : null,
      },
    },
  )

  return update.matchedCount > 0
}

/**
 * Record a video this pipeline will not attempt — too large, or with nothing encodable in it.
 *
 * Kept apart from `failed` so that an operator sweeping failures back into the queue does not
 * keep picking up videos that were excluded on purpose, and will be excluded again.
 */
export async function skipTranscode(
  videoId: string,
  workerId: string,
  reason: string,
): Promise<boolean> {
  const update = await VideoModel.updateOne(
    { _id: videoId, 'transcode.workerId': workerId },
    {
      $set: {
        'transcode.status': 'skipped',
        'transcode.error': reason.slice(0, 500),
        'transcode.finishedAt': new Date(),
      },
    },
  )

  return update.matchedCount > 0
}
