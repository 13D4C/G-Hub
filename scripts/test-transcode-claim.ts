/**
 * Self-check for the transcode queue's claim semantics, against a real database.
 *
 * Run: npm run test:transcode-claim   (needs .env and a reachable MongoDB)
 *
 * Everything decidable about a transcode is tested without a database by
 * `test-transcode-plan.ts`. What is left here is the part that only exists in the database:
 * whether two workers can take the same video, whether a worker that dies mid-encode ever
 * gets its job back, and whether a worker that lost its lease can still overwrite the result
 * of the one that replaced it. None of those can be observed by reasoning about the code —
 * they are properties of one atomic update, and the way to check an atomic update is to run
 * it.
 *
 * Needs no ffmpeg: `transcode-queue.ts` deliberately contains no encoding, precisely so this
 * can run on a machine that cannot transcode.
 */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { UserModel } from '../src/server/db/models/user.ts'
import { VideoModel } from '../src/server/db/models/video.ts'
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import {
  claimNextVideo,
  completeTranscode,
  failTranscode,
  makeWorkerId,
  renewClaim,
} from '../src/server/lib/transcode-queue.ts'
import { MAX_ATTEMPTS } from '../src/server/lib/transcode-plan.ts'

const tag = `transcode-test-${Date.now()}`

/**
 * Queue a video far enough in the past that it is claimable immediately.
 *
 * Every other video in the database is claimable too, so each assertion below re-reads the
 * row it created by id rather than trusting that a claim returned "its" video — a developer
 * machine pointed at a shared database would otherwise fail this suite for reasons that have
 * nothing to do with the code.
 */
async function seedVideo(creatorId: mongoose.Types.ObjectId, over: Record<string, unknown> = {}) {
  return VideoModel.create({
    title: `${tag} clip`,
    url: 'http://example.test/g-hub-media/videos/none.mp4',
    uploadedBy: creatorId,
    visibility: 'public',
    transcode: {
      status: 'pending',
      nextAttemptAt: new Date(Date.now() - 60_000),
      attempts: 0,
      ...over,
    },
  })
}

/** The queue state of one video, read back fresh. */
async function stateOf(id: mongoose.Types.ObjectId) {
  const row = await VideoModel.findById(id).select('transcode durationSeconds').lean()
  assert.ok(row, 'the seeded video should still exist')
  return row
}

async function main() {
  await connectToDatabase()

  // The claim reads through this index on every poll of every worker. Building it here also
  // surfaces a failed build as an error now rather than as a collection scan in production.
  await VideoModel.syncIndexes()

  const creator = await UserModel.create({
    email: `${tag}-creator@example.test`,
    googleId: `${tag}-creator`,
    name: 'Transcode Test Creator',
    channelName: 'Transcode Test Channel',
  })

  // --- a claim is exclusive -------------------------------------------------------

  {
    const video = await seedVideo(creator._id)
    const workerA = makeWorkerId()

    const claimed = await claimNextVideo(workerA)
    assert.ok(claimed, 'a queued video is claimable')

    const after = await stateOf(video._id)
    assert.equal(after.transcode?.status, 'processing', 'claiming marks the row as in progress')
    assert.equal(after.transcode?.attempts, 1, 'and spends an attempt on the claim itself')
    assert.ok(after.transcode?.prefix, 'and mints an output prefix for this attempt')
    assert.ok(
      (after.transcode?.nextAttemptAt?.getTime() ?? 0) > Date.now(),
      'and pushes the lease into the future, which is what hides it from other workers',
    )

    // The whole concurrency story in one assertion: a second worker polling immediately must
    // not be handed the row the first one is holding.
    const workerB = makeWorkerId()
    for (let i = 0; i < 5; i += 1) {
      const other = await claimNextVideo(workerB)
      assert.notEqual(
        other?.id,
        String(video._id),
        'a leased video must not be handed to a second worker',
      )
      if (!other) break
    }
  }

  // --- a worker that dies gets its job back ----------------------------------------

  {
    // Exactly the row a killed worker leaves behind: still `processing`, an attempt already
    // spent, and a lease that has run out. Nothing sweeps this up — the claim query simply
    // matches it again, which is why `processing` is in the match at all.
    const video = await seedVideo(creator._id, {
      status: 'processing',
      attempts: 1,
      workerId: 'a-worker-that-died',
      nextAttemptAt: new Date(Date.now() - 60_000),
    })

    const worker = makeWorkerId()
    let reclaimed = false
    for (let i = 0; i < 20; i += 1) {
      const claimed = await claimNextVideo(worker)
      if (!claimed) break
      if (claimed.id === String(video._id)) {
        reclaimed = true
        break
      }
    }

    assert.ok(reclaimed, 'an expired lease is re-claimable without any cleanup pass')
    const after = await stateOf(video._id)
    assert.equal(after.transcode?.attempts, 2, 'and the re-claim spends another attempt')
  }

  // --- attempts are finite ----------------------------------------------------------

  {
    const video = await seedVideo(creator._id, { attempts: MAX_ATTEMPTS })
    const worker = makeWorkerId()

    for (let i = 0; i < 20; i += 1) {
      const claimed = await claimNextVideo(worker)
      if (!claimed) break
      assert.notEqual(
        claimed.id,
        String(video._id),
        'a video that has spent every attempt is never claimed again — this is what stops a file that kills the worker from restarting it forever',
      )
    }
  }

  // --- every finishing write is guarded on the worker that holds the lease -----------

  {
    const video = await seedVideo(creator._id, {
      status: 'processing',
      attempts: 1,
      workerId: 'the-worker-that-holds-it',
      nextAttemptAt: new Date(Date.now() + 60_000),
    })

    const impostor = makeWorkerId()

    // This is the case the guards exist for: a worker whose lease lapsed during a long
    // encode, finishing after another worker has taken the job over. Without the guard it
    // would overwrite a result it knows nothing about, with urls pointing at a segment tree
    // the live attempt is not using.
    const wroteResult = await completeTranscode(String(video._id), impostor, {
      hlsUrl: 'http://example.test/wrong/master.m3u8',
      dashUrl: 'http://example.test/wrong/manifest.mpd',
      renditions: [{ width: 0, height: 720, bitrateKbps: 2928 }],
      sourceWidth: 1280,
      sourceHeight: 720,
      durationSeconds: 99,
    })

    assert.equal(wroteResult, false, 'a worker without the lease cannot record a result')

    const afterComplete = await stateOf(video._id)
    assert.equal(afterComplete.transcode?.status, 'processing', 'and the row is untouched')
    assert.equal(afterComplete.transcode?.hlsUrl, '', 'no manifest url was written')
    assert.notEqual(afterComplete.durationSeconds, 99, 'and the duration was not overwritten')

    assert.equal(
      await failTranscode(String(video._id), impostor, 1, new Error('not mine to fail')),
      false,
      'nor can it record a failure, which would spend an attempt belonging to another worker',
    )

    // The signal the worker aborts on. A renewal that reports the lease is gone is the only
    // way a long encode learns it has been replaced.
    assert.equal(
      await renewClaim(String(video._id), impostor),
      false,
      'and renewing a lease it does not hold reports false rather than stealing it',
    )
    assert.equal(
      await renewClaim(String(video._id), 'the-worker-that-holds-it'),
      true,
      'while the worker that does hold it can renew',
    )
  }

  // --- the happy path writes what it should -----------------------------------------

  {
    const video = await seedVideo(creator._id)
    const worker = makeWorkerId()

    await VideoModel.updateOne(
      { _id: video._id },
      { $set: { 'transcode.workerId': worker, 'transcode.status': 'processing' } },
    )

    const wrote = await completeTranscode(String(video._id), worker, {
      hlsUrl: 'http://example.test/right/master.m3u8',
      dashUrl: 'http://example.test/right/manifest.mpd',
      renditions: [
        { width: 0, height: 360, bitrateKbps: 928 },
        { width: 0, height: 720, bitrateKbps: 2928 },
      ],
      sourceWidth: 1280,
      sourceHeight: 720,
      durationSeconds: 42,
    })

    assert.equal(wrote, true, 'the worker holding the lease records its result')

    const after = await stateOf(video._id)
    assert.equal(after.transcode?.status, 'ready')
    assert.equal(after.transcode?.hlsUrl, 'http://example.test/right/master.m3u8')
    assert.equal(after.transcode?.renditions?.length, 2)
    assert.equal(
      after.durationSeconds,
      42,
      'the probed duration replaces whatever the upload form reported, which nothing verified',
    )

    // And it leaves the queue: a finished video must not be claimable, or every worker would
    // re-encode the whole catalogue on a loop.
    const other = makeWorkerId()
    for (let i = 0; i < 20; i += 1) {
      const claimed = await claimNextVideo(other)
      if (!claimed) break
      assert.notEqual(claimed.id, String(video._id), 'a ready video is not claimable')
    }
  }

  console.log('transcode claim: all checks passed')
}

main()
  .catch((err) => {
    console.error('transcode claim FAILED:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    // Best effort: a failed run should still not leave test rows behind.
    await Promise.all([
      VideoModel.deleteMany({ title: new RegExp(`^${tag} `) }),
      UserModel.deleteMany({ email: new RegExp(`^${tag}-`) }),
    ]).catch(() => {})
    await mongoose.disconnect()
  })
