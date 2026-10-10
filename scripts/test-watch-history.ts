/**
 * Integration check for the per-viewer watch record that personalizes the feed,
 * against the local Mongo in MONGODB_URI.
 *
 * Run: npm run test:watch-history
 *
 * The sibling of `test-ppv-gate.ts`, covering the one write this feature adds to the
 * playback path. Two properties carry the weight:
 *
 * - A rewatch increments a row rather than adding one. The unique index is what
 *   enforces it, and an index that silently failed to build would only show up here.
 * - `recordWatch` never throws. It runs inside the same `Promise.all` as the
 *   `viewCount` increment in `getVideoById`, so a rejection would turn a successful
 *   playback into a 500 — the one way this feature can break something that already
 *   worked.
 *
 * Also checks that `loadSubscribedCreatorIds` reads back what it should, since it is
 * the other new query and the feed's candidate set is empty without it.
 *
 * Creates its own throwaway users/videos and deletes them again, so it is safe to run
 * against a dev database.
 */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { ChannelSubscriptionModel } from '../src/server/db/models/channel-subscription.ts'
import { UserModel } from '../src/server/db/models/user.ts'
import { VideoModel } from '../src/server/db/models/video.ts'
import { VideoViewModel } from '../src/server/db/models/video-view.ts'
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import { loadSubscribedCreatorIds } from '../src/server/lib/entitlement.ts'
import { loadViewerSignals, recordWatch } from '../src/server/lib/watch-history.ts'

const tag = `watch-test-${Date.now()}`

async function main() {
  await connectToDatabase()

  const creator = await UserModel.create({
    email: `${tag}-creator@example.test`,
    googleId: `${tag}-creator`,
    name: 'Watch Test Creator',
    channelName: 'Watch Test Channel',
  })
  const other = await UserModel.create({
    email: `${tag}-other@example.test`,
    googleId: `${tag}-other`,
    name: 'Watch Test Other Creator',
  })
  const viewer = await UserModel.create({
    email: `${tag}-viewer@example.test`,
    googleId: `${tag}-viewer`,
    name: 'Watch Test Viewer',
  })
  const viewerId = String(viewer._id)

  const first = await VideoModel.create({
    title: `${tag} first`,
    url: 'http://example.test/first.mp4',
    uploadedBy: creator._id,
    visibility: 'public',
  })
  const second = await VideoModel.create({
    title: `${tag} second`,
    url: 'http://example.test/second.mp4',
    uploadedBy: creator._id,
    visibility: 'public',
  })
  const elsewhere = await VideoModel.create({
    title: `${tag} elsewhere`,
    url: 'http://example.test/elsewhere.mp4',
    uploadedBy: other._id,
    visibility: 'public',
  })

  // --- a rewatch increments, it does not accumulate rows -------------------------
  await recordWatch(viewerId, first)
  await recordWatch(viewerId, first)
  await recordWatch(viewerId, first)

  const rows = await VideoViewModel.find({ viewerId, videoId: first._id }).lean()
  assert.equal(rows.length, 1, 'three watches of one video leave one row')
  assert.equal(rows[0].watchCount, 3, 'and that row counts all three')
  assert.equal(String(rows[0].creatorId), String(creator._id), 'denormalized off the video')
  assert.ok(rows[0].lastWatchedAt instanceof Date, 'and records when it last happened')

  // --- an anonymous viewer writes nothing at all ---------------------------------
  const before = await VideoViewModel.countDocuments({})
  await recordWatch(null, first)
  assert.equal(
    await VideoViewModel.countDocuments({}),
    before,
    'an anonymous watch is not recorded — there is no viewer to attribute it to',
  )

  // --- it never throws, whatever it is handed ------------------------------------
  // The property that makes it safe to await beside the `viewCount` increment. A
  // video id that is not an ObjectId is the realistic version of this: a cast error
  // thrown here would surface as a failed playback of a video that played fine.
  await recordWatch(viewerId, { _id: 'not-an-object-id', uploadedBy: creator._id })
  await recordWatch(viewerId, { _id: new mongoose.Types.ObjectId(), uploadedBy: null })
  console.log('  (the two errors logged above are expected — recordWatch swallowing them)')

  // --- signals group per creator --------------------------------------------------
  await recordWatch(viewerId, second)
  await recordWatch(viewerId, elsewhere)

  const signals = await loadViewerSignals(viewerId, [])
  assert.equal(
    signals.creatorWatchCounts[String(creator._id)],
    4,
    'affinity sums watches across a channel: three of one video plus one of another',
  )
  assert.equal(signals.creatorWatchCounts[String(other._id)], 1, 'and counts other channels apart')
  assert.equal(signals.watchedVideoIds.length, 3, 'every watched video is reported as seen')
  assert.ok(
    signals.watchedVideoIds.includes(String(first._id)),
    'including the one watched most often',
  )

  // An anonymous viewer has no signals, and asking costs no query.
  const anonymous = await loadViewerSignals(null, [])
  assert.deepEqual(anonymous.watchedVideoIds, [])
  assert.deepEqual(anonymous.creatorWatchCounts, {})

  // --- the subscription query the feed's candidate set depends on -----------------
  assert.deepEqual(
    await loadSubscribedCreatorIds(viewerId),
    [],
    'a viewer who pays for nothing subscribes to nothing',
  )
  assert.deepEqual(await loadSubscribedCreatorIds(null), [], 'and an anonymous one likewise')

  await ChannelSubscriptionModel.create({
    subscriberId: viewer._id,
    creatorId: creator._id,
    stripeCustomerId: 'cus_watch_test',
    stripeSubscriptionId: `sub_${tag}`,
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 86_400_000),
  })
  assert.deepEqual(
    await loadSubscribedCreatorIds(viewerId),
    [{ creatorId: String(creator._id), tierId: null }],
    'an active subscription is reported, with no tier for a channel-level one',
  )

  // Expiry is decided by `isEntitled`, not by the status alone — the `$in` on status
  // only narrows the query, so a row that says `active` past its period must still
  // drop out here exactly as it would in `getChannelAccess`.
  await ChannelSubscriptionModel.updateOne(
    { subscriberId: viewer._id, creatorId: creator._id },
    { currentPeriodEnd: new Date(Date.now() - 86_400_000) },
  )
  assert.deepEqual(
    await loadSubscribedCreatorIds(viewerId),
    [],
    'an active row past its period entitles nobody',
  )

  console.log('watch history: all checks passed')
}

main()
  .catch((err) => {
    console.error('watch history FAILED:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    // Best effort: a failed run should still not leave test rows behind.
    const users = await UserModel.find({ email: new RegExp(`^${tag}-`) })
      .select('_id')
      .lean()
      .catch(() => [])
    const userIds = users.map((u) => u._id)
    await Promise.all([
      VideoViewModel.deleteMany({ viewerId: { $in: userIds } }),
      UserModel.deleteMany({ email: new RegExp(`^${tag}-`) }),
      VideoModel.deleteMany({ title: new RegExp(`^${tag} `) }),
      ChannelSubscriptionModel.deleteMany({ stripeCustomerId: 'cus_watch_test' }),
    ]).catch(() => {})
    await mongoose.disconnect()
  })
