/**
 * Queue videos that predate the transcoding pipeline, so they get HLS and DASH too.
 *
 * Run:
 *   npm run backfill:transcode                            # dry run, the default
 *   npm run backfill:transcode:apply                      # queue them — works in any shell
 *   npm run backfill:transcode -- --apply --limit 50 --spread-minutes 60
 *   npm run backfill:transcode -- --apply --reset-failed
 *
 * In PowerShell, quote the separator: `npm run <script> '--' --flag`. PowerShell's `npm.ps1`
 * shim consumes a bare `--` as its own end-of-parameters marker, so npm never sees it and the
 * flag vanishes without an error — which for this script means a dry run that looks like it
 * worked. The `:apply` / `:once` scripts exist so the common cases need no quoting at all.
 *
 * A video uploaded before this pipeline has no `transcode` field at all, and that absence is
 * what makes it a plain progressive MP4 everywhere in the app rather than a broken row. So
 * nothing changed when the pipeline shipped, and nothing changes until this is run: opting
 * the back catalogue in is a separate decision, taken here, at a pace you choose.
 *
 * Idempotent. It matches only rows with no `transcode` field, and after a successful run
 * there are none left among the ones it touched. It never touches a video that is already
 * `ready`, `failed` or `skipped` unless `--reset-failed` says so.
 *
 * Why the pacing flags are not conveniences: one worker encodes a five-rung ladder at
 * roughly real time, on the same machine that serves the site. Queueing a few hundred
 * videos at once is hours of saturated CPU. And because the claim is ordered by
 * `nextAttemptAt` alone, giving every row the same timestamp makes the order arbitrary —
 * spreading them produces a predictable drip and a rate limit at the same time.
 */
import mongoose from 'mongoose'
import { VideoModel } from '../src/server/db/models/video.ts'
import { connectToDatabase } from '../src/server/db/mongoose.ts'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const resetFailed = args.includes('--reset-failed')

function numberFlag(name: string, fallback: number): number {
  const inline = args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
  const positional = args[args.indexOf(`--${name}`) + 1]
  const raw = Number(inline ?? (args.includes(`--${name}`) ? positional : undefined))
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

const limit = numberFlag('limit', 25)
const spreadMinutes = numberFlag('spread-minutes', 30)

/** Rows written before the pipeline existed: no `transcode` field at all. */
const neverQueued = { 'transcode.status': { $exists: false } }

/**
 * Videos that ran out of attempts, which `--reset-failed` sweeps back into the queue.
 *
 * `as const` for the same reason `entitlement.ts` needs it: without it the literal widens to
 * `string` and stops satisfying Mongoose's typed filter for the status enum.
 */
const spent = { 'transcode.status': 'failed' as const }

async function reportCurrentState(): Promise<void> {
  const byStatus = await VideoModel.aggregate<{ _id: string | null; count: number }>([
    { $group: { _id: '$transcode.status', count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ])

  console.log('Current state:')
  for (const row of byStatus) {
    console.log(`  ${String(row._id ?? '(never queued)').padEnd(16)} ${row.count}`)
  }
}

async function main() {
  await connectToDatabase()

  await reportCurrentState()
  console.log('')

  const filter = resetFailed ? spent : neverQueued
  const label = resetFailed ? 'failed' : 'never queued'

  const waiting = await VideoModel.countDocuments(filter)
  if (waiting === 0) {
    console.log(`Nothing to do: no videos are ${label}.`)
    return
  }

  // Newest first, so the catalogue people are actually watching gets adaptive streaming
  // before the archive does.
  const batch = await VideoModel.find(filter)
    .select('_id title')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean()

  console.log(
    `${waiting} video(s) ${label}; this run would queue ${batch.length}, spread over ${spreadMinutes} minute(s).`,
  )

  if (!apply) {
    console.log('')
    for (const video of batch.slice(0, 10)) {
      console.log(`  ${String(video._id)}  ${video.title}`)
    }
    if (batch.length > 10) console.log(`  ... and ${batch.length - 10} more`)
    console.log('')
    console.log('Dry run. To queue them: npm run backfill:transcode:apply')
    return
  }

  const spreadMs = spreadMinutes * 60_000
  const now = Date.now()

  const operations = batch.map((video, index) => ({
    updateOne: {
      filter: { _id: video._id },
      update: {
        $set: {
          'transcode.status': 'pending',
          'transcode.attempts': 0,
          // Evenly spaced rather than all at once. The claim sorts on this field alone, so
          // identical timestamps would make the order arbitrary and hand the whole batch to
          // the first worker to wake up.
          'transcode.nextAttemptAt': new Date(
            now + Math.round((index / Math.max(1, batch.length - 1)) * spreadMs),
          ),
          'transcode.workerId': '',
          'transcode.prefix': '',
          'transcode.error': '',
          'transcode.startedAt': null,
          'transcode.finishedAt': null,
        },
      },
    },
  }))

  const result = await VideoModel.bulkWrite(operations)
  console.log(`Queued ${result.modifiedCount} video(s).`)

  const remaining = waiting - batch.length
  if (remaining > 0) {
    console.log(`${remaining} still ${label}. Run again once this batch has drained.`)
  }
  console.log('Start a worker with: npm run transcode-worker')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => mongoose.disconnect())
