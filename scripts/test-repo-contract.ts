import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

const backend = process.env.DATA_BACKEND === 'dynamo' ? 'dynamo' : 'mongo'

const {
  videoLikes,
  videoViews,
  channelSubscriptions,
  ads,
  videoComments,
  membershipTiers,
  users,
  videos,
  tips,
  videoPurchases,
  subscriptionInvoices,
  adImpressions,
  DuplicateEmail,
  DuplicateTierName,
} = await import('../src/server/data/index.ts')

// Mongoose builds indexes in the background, so on a fresh database the unique ones
// this contract depends on may not exist yet when the first duplicate is attempted.
if (backend === 'mongo') {
  const { connectToDatabase } = await import('../src/server/db/mongoose.ts')
  await connectToDatabase()
  const models = await Promise.all([
    import('../src/server/db/models/video-like.ts'),
    import('../src/server/db/models/video-view.ts'),
    import('../src/server/db/models/channel-subscription.ts'),
    import('../src/server/db/models/membership-tier.ts'),
    import('../src/server/db/models/user.ts'),
  ])
  await Promise.all([
    models[0].VideoLikeModel.init(),
    models[1].VideoViewModel.init(),
    models[2].ChannelSubscriptionModel.init(),
    models[3].MembershipTierModel.init(),
    models[4].UserModel.init(),
  ])
}

const oid = () => randomBytes(12).toString('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const video = oid()
const userA = oid()
const userB = oid()

assert.equal(await videoLikes.exists(video, userA), false, 'no like yet')
assert.equal(await videoLikes.insert(video, userA), true, 'first insert reports inserted')
assert.equal(await videoLikes.exists(video, userA), true, 'the like is readable')
assert.equal(await videoLikes.insert(video, userA), false, 'a duplicate reports not inserted')
assert.equal(await videoLikes.remove(video, userA), true, 'removing an existing like reports true')
assert.equal(await videoLikes.remove(video, userA), false, 'removing again reports false')
assert.equal(await videoLikes.exists(video, userA), false, 'and it is gone')

await videoLikes.insert(video, userA)
await videoLikes.insert(video, userB)
const counts = await videoLikes.countByVideo()
assert.equal(counts.get(video), 2, 'countByVideo sees both likes')

await videoLikes.removeByVideo(video)
assert.equal(await videoLikes.exists(video, userA), false, 'removeByVideo swept userA')
assert.equal(await videoLikes.exists(video, userB), false, 'removeByVideo swept userB')

const viewer = oid()
const creator = oid()
const otherCreator = oid()
const vid1 = oid()
const vid2 = oid()
const vid3 = oid()

await videoViews.recordWatch(viewer, vid1, creator)
await sleep(5)
await videoViews.recordWatch(viewer, vid1, creator)
await sleep(5)
await videoViews.recordWatch(viewer, vid1, creator)
await sleep(5)
await videoViews.recordWatch(viewer, vid2, creator)
await sleep(5)
await videoViews.recordWatch(viewer, vid3, otherCreator)

const signals = await videoViews.recentByViewer(viewer, 200)
assert.equal(signals.length, 3, 'three distinct videos leave three rows')

const byVideo = new Map(signals.map((s) => [s.videoId, s]))
assert.equal(byVideo.get(vid1)?.watchCount, 3, 'repeat watches accumulate on one row')
assert.equal(byVideo.get(vid1)?.creatorId, creator, 'creatorId is denormalized onto the row')
assert.equal(byVideo.get(vid2)?.watchCount, 1, 'a single watch counts once')
assert.equal(byVideo.get(vid3)?.creatorId, otherCreator, 'other channels stay distinct')

assert.equal(signals[0].videoId, vid3, 'most recently watched comes first')
assert.deepEqual(
  (await videoViews.recentByViewer(viewer, 2)).map((s) => s.videoId),
  [vid3, vid2],
  'the limit takes the most recent',
)

assert.deepEqual(await videoViews.recentByViewer(oid(), 200), [], 'an unknown viewer has no rows')

const subscriber = oid()
const chanA = oid()
const chanB = oid()
const tier = oid()

assert.equal(await channelSubscriptions.find(subscriber, chanA), null, 'no subscription yet')

await channelSubscriptions.upsert(subscriber, chanA, {
  stripeCustomerId: 'cus_contract',
  priceCents: 499,
  currency: 'usd',
  tierId: tier,
  tierName: 'Gold',
})

const pending = await channelSubscriptions.find(subscriber, chanA)
assert.ok(pending, 'the row exists after upsert')
assert.equal(pending.status, 'incomplete', 'an inserted row takes the default status')
assert.equal(pending.cancelAtPeriodEnd, false, 'and the default cancel flag')
assert.equal(pending.stripeSubscriptionId, '', 'and the default empty subscription id')
assert.equal(pending.priceCents, 499, 'while the patch is applied')
assert.equal(pending.tierId, tier, 'tier ids round-trip as strings')
assert.equal(pending.tierName, 'Gold')

const periodEnd = new Date(Date.now() + 30 * 86_400_000)
await channelSubscriptions.upsert(subscriber, chanA, {
  status: 'active',
  currentPeriodEnd: periodEnd,
  stripeSubscriptionId: 'sub_contract',
  cancelAtPeriodEnd: true,
})

const active = await channelSubscriptions.find(subscriber, chanA)
assert.ok(active)
assert.equal(active.status, 'active', 'the second upsert updates')
assert.equal(active.currentPeriodEnd?.getTime(), periodEnd.getTime(), 'dates round-trip')
assert.equal(active.cancelAtPeriodEnd, true)
assert.equal(active.stripeCustomerId, 'cus_contract', 'fields the patch omits are preserved')
assert.equal(active.priceCents, 499, 'including ones defaulted on insert')

await channelSubscriptions.upsert(subscriber, chanB, { status: 'canceled' })

const entitling = await channelSubscriptions.listBySubscriber(subscriber, ['active', 'trialing'])
assert.deepEqual(
  entitling.map((r) => r.creatorId),
  [chanA],
  'listBySubscriber filters by status',
)

const all = await channelSubscriptions.listBySubscriber(subscriber, [
  'active',
  'trialing',
  'canceled',
])
assert.equal(all.length, 2, 'and returns every matching status')

const subscriberB = oid()
await channelSubscriptions.upsert(subscriberB, chanA, { status: 'active' })

for (let attempt = 0; ; attempt++) {
  const byCreator = await channelSubscriptions.listByCreator(chanA)
  if (byCreator.length === 2 || attempt === 10) {
    assert.deepEqual(
      byCreator.map((r) => r.subscriberId).sort(),
      [subscriber, subscriberB].sort(),
      'listByCreator finds every subscriber of a channel',
    )
    break
  }
  await sleep(100)
}

assert.deepEqual(await channelSubscriptions.listByCreator(oid()), [], 'an unknown channel has none')

const adTitle = `contract-ad-${randomBytes(6).toString('hex')}`
await ads.upsertByTitle(adTitle, {
  mediaUrl: 's3://bucket/ads/one.mp4',
  skippableAfterSeconds: 3,
  weight: 1,
  active: true,
})

const activeAds = await ads.listActive()
const seeded = activeAds.filter((a) => a.title === adTitle)
assert.equal(seeded.length, 1, 'the seeded ad is listed exactly once')
assert.equal(seeded[0].mediaUrl, 's3://bucket/ads/one.mp4')
assert.equal(seeded[0].skippableAfterSeconds, 3)
assert.equal(seeded[0].weight, 1)
assert.ok(seeded[0].id, 'an ad carries an id')

await ads.upsertByTitle(adTitle, {
  mediaUrl: 's3://bucket/ads/two.mp4',
  skippableAfterSeconds: 5,
  weight: 2,
  active: true,
})
const reseeded = (await ads.listActive()).filter((a) => a.title === adTitle)
assert.equal(reseeded.length, 1, 'upserting the same title does not duplicate')
assert.equal(reseeded[0].mediaUrl, 's3://bucket/ads/two.mp4', 'and it updates in place')

const cVideo = oid()
const cAuthor = oid()
const cStranger = oid()

assert.equal(await videoComments.countByVideo(cVideo), 0, 'no comments yet')
assert.deepEqual(await videoComments.listByVideo(cVideo, 10, null), [], 'and none to list')

const first = await videoComments.create(cVideo, cAuthor, 'first')
await sleep(5)
const second = await videoComments.create(cVideo, cAuthor, 'second')
await sleep(5)
await videoComments.create(cVideo, cStranger, 'third')

assert.ok(first.id && first.createdAt instanceof Date, 'a created comment carries id and date')
assert.equal(first.editedAt, null, 'and is unedited')
assert.equal(await videoComments.countByVideo(cVideo), 3, 'all three are counted')

const newestFirst = await videoComments.listByVideo(cVideo, 10, null)
assert.deepEqual(
  newestFirst.map((c) => c.body),
  ['third', 'second', 'first'],
  'comments come back newest first',
)

const pageOne = await videoComments.listByVideo(cVideo, 2, null)
assert.deepEqual(pageOne.map((c) => c.body), ['third', 'second'], 'the first page respects limit')
const pageTwo = await videoComments.listByVideo(cVideo, 2, pageOne[pageOne.length - 1].id)
assert.deepEqual(pageTwo.map((c) => c.body), ['first'], 'the cursor continues past it')

assert.equal(
  await videoComments.updateOwn(first.id, cStranger, 'hijacked', new Date()),
  null,
  'a non-owner cannot edit',
)
const editedAt = new Date()
const edited = await videoComments.updateOwn(first.id, cAuthor, 'edited', editedAt)
assert.ok(edited, 'the owner can edit')
assert.equal(edited.body, 'edited')
assert.equal(edited.editedAt?.getTime(), editedAt.getTime(), 'editedAt round-trips')
assert.equal(edited.videoId, cVideo, 'and the row still knows its video')

assert.equal(await videoComments.deleteOwn(second.id, cStranger), null, 'a non-owner cannot delete')
const removedComment = await videoComments.deleteOwn(second.id, cAuthor)
assert.equal(removedComment?.videoId, cVideo, 'deleting returns the video it belonged to')
assert.equal(await videoComments.countByVideo(cVideo), 2, 'and the count drops')

await videoComments.deleteByVideo(cVideo)
assert.equal(await videoComments.countByVideo(cVideo), 0, 'deleteByVideo sweeps the thread')

const tierCreator = oid()
const rivalCreator = oid()

assert.equal(await membershipTiers.countActiveByCreator(tierCreator), 0, 'no tiers yet')
assert.deepEqual(await membershipTiers.listActiveByCreator(tierCreator), [], 'and none to list')
assert.deepEqual(await membershipTiers.listByIds([]), [], 'listByIds tolerates an empty list')

const silver = await membershipTiers.create(tierCreator, {
  name: 'Silver',
  description: 'entry',
  priceCents: 499,
  currency: 'usd',
  rank: 1,
})
const gold = await membershipTiers.create(tierCreator, {
  name: 'Gold',
  description: 'top',
  priceCents: 999,
  currency: 'usd',
  rank: 0,
})

assert.ok(silver.id && gold.id, 'tiers carry ids')
assert.equal(await membershipTiers.countActiveByCreator(tierCreator), 2)

await assert.rejects(
  () =>
    membershipTiers.create(tierCreator, {
      name: 'Gold',
      description: '',
      priceCents: 100,
      currency: 'usd',
      rank: 5,
    }),
  (err: unknown) => err instanceof DuplicateTierName,
  'a duplicate live name is refused',
)

const otherGold = await membershipTiers.create(rivalCreator, {
  name: 'Gold',
  description: '',
  priceCents: 100,
  currency: 'usd',
  rank: 0,
})
assert.ok(otherGold.id, 'another creator may use the same tier name')

assert.deepEqual(
  (await membershipTiers.listActiveByCreator(tierCreator)).map((t) => t.name),
  ['Gold', 'Silver'],
  'the ladder sorts by rank then name',
)

const byId = await membershipTiers.findById(gold.id)
assert.equal(byId?.name, 'Gold', 'findById reads a tier')
assert.equal(byId?.priceCents, 999)
assert.equal(byId?.active, true)
assert.equal(await membershipTiers.findById(oid()), null, 'an unknown id is null')

assert.ok(await membershipTiers.findActiveOwned(gold.id, tierCreator), 'the owner finds it')
assert.equal(
  await membershipTiers.findActiveOwned(gold.id, rivalCreator),
  null,
  'another creator does not',
)

const ranks = await membershipTiers.listByIds([gold.id, silver.id, oid()])
assert.equal(ranks.length, 2, 'listByIds skips ids that do not exist')
assert.deepEqual(
  new Map(ranks.map((t) => [t.id, t.rank])).get(gold.id),
  0,
  'and carries each rank',
)

const renamed = await membershipTiers.updateOwn(gold.id, tierCreator, {
  name: 'Platinum',
  priceCents: 1299,
})
assert.equal(renamed?.name, 'Platinum', 'the owner can rename')
assert.equal(renamed?.priceCents, 1299)
assert.equal(renamed?.description, 'top', 'fields the patch omits survive')
assert.equal(
  await membershipTiers.updateOwn(gold.id, rivalCreator, { name: 'Stolen' }),
  null,
  'another creator cannot',
)

await assert.rejects(
  () => membershipTiers.updateOwn(silver.id, tierCreator, { name: 'Platinum' }),
  (err: unknown) => err instanceof DuplicateTierName,
  'renaming onto a live name is refused',
)

const freed = await membershipTiers.create(tierCreator, {
  name: 'Gold',
  description: '',
  priceCents: 200,
  currency: 'usd',
  rank: 3,
})
assert.ok(freed.id, 'the old name is free once its tier was renamed away')

assert.equal(await membershipTiers.archive(freed.id, rivalCreator), false, 'only the owner archives')
assert.equal(await membershipTiers.archive(freed.id, tierCreator), true, 'the owner archives')
assert.equal(await membershipTiers.archive(freed.id, tierCreator), false, 'archiving twice is false')

assert.equal(
  (await membershipTiers.findById(freed.id))?.active,
  false,
  'an archived tier still resolves, inactive',
)
assert.equal(
  await membershipTiers.findActiveOwned(freed.id, tierCreator),
  null,
  'but is not findable as active',
)
assert.ok(
  !(await membershipTiers.listActiveByCreator(tierCreator)).some((t) => t.id === freed.id),
  'and leaves the ladder',
)

const reused = await membershipTiers.create(tierCreator, {
  name: 'Gold',
  description: '',
  priceCents: 300,
  currency: 'usd',
  rank: 4,
})
assert.ok(reused.id, 'an archived name can be used again — the unique index is partial')

const tag = randomBytes(6).toString('hex')
const mail = (who: string) => `${who}-${tag}@kmitl.ac.th`

assert.equal(await users.findByEmail(mail('nobody')), null, 'no such account')
assert.equal(await users.findByGoogleId(`google-${tag}-none`), null, 'no such google account')
assert.equal(await users.findById(oid()), null, 'no such id')
assert.deepEqual(await users.listByIds([]), [], 'listByIds tolerates empty')

const alice = await users.create({
  email: mail('alice'),
  passwordHash: 'hash-alice',
  name: 'Alice',
})
assert.ok(alice.id, 'a created user carries an id')
assert.equal(alice.email, mail('alice'))
assert.equal(alice.name, 'Alice')
assert.equal(alice.googleId, null, 'a password account has no google id')
assert.equal(alice.channelCurrency, 'usd', 'defaults are applied on insert')
assert.equal(alice.stripeCustomerId, '', 'and the customer id starts empty')
assert.equal(alice.channelName, '')

const foundById = await users.findById(alice.id)
assert.equal(foundById?.email, alice.email, 'findById reads it back')
assert.equal(foundById?.passwordHash, 'hash-alice', 'including the password hash')

const foundByEmail = await users.findByEmail(mail('alice'))
assert.equal(foundByEmail?.id, alice.id, 'findByEmail reads it back')
assert.equal(
  (await users.findByEmail(mail('alice').toUpperCase()))?.id,
  alice.id,
  'email lookup ignores case',
)

await assert.rejects(
  () => users.create({ email: mail('alice'), passwordHash: 'other', name: 'Impostor' }),
  (err: unknown) => err instanceof DuplicateEmail,
  'a second account cannot take the same email',
)

const bobGoogle = `google-${tag}-bob`
const bob = await users.create({
  email: mail('bob'),
  googleId: bobGoogle,
  name: 'Bob',
  avatarUrl: 'https://example.test/bob.png',
})
assert.equal((await users.findByGoogleId(bobGoogle))?.id, bob.id, 'findByGoogleId reads it back')
assert.equal(bob.passwordHash, null, 'a google account has no password hash')

await assert.rejects(
  () => users.create({ email: mail('carol'), googleId: bobGoogle, name: 'Impostor' }),
  (err: unknown) => err instanceof DuplicateEmail,
  'a second account cannot take the same google id',
)
assert.equal(
  await users.findByEmail(mail('carol')),
  null,
  'and the rejected account left no row behind',
)

const listed = await users.listByIds([alice.id, bob.id, oid()])
assert.equal(listed.length, 2, 'listByIds skips ids that do not exist')
assert.deepEqual(listed.map((u) => u.id).sort(), [alice.id, bob.id].sort())

await users.updateProfile(alice.id, {
  channelName: 'Alice Channel',
  channelDescription: 'hello',
  channelCurrency: 'thb',
  name: 'Alice A.',
})
const updated = await users.findById(alice.id)
assert.equal(updated?.channelName, 'Alice Channel')
assert.equal(updated?.channelDescription, 'hello')
assert.equal(updated?.channelCurrency, 'thb')
assert.equal(updated?.name, 'Alice A.', 'name is writable despite being a reserved word')
assert.equal(updated?.email, mail('alice'), 'and the email is untouched')
assert.equal(updated?.passwordHash, 'hash-alice', 'as is the password hash')

const aliceGoogle = `google-${tag}-alice`
await users.linkGoogle(alice.id, { googleId: aliceGoogle, avatarUrl: 'https://example.test/a.png' })
const linked = await users.findById(alice.id)
assert.equal(linked?.googleId, aliceGoogle, 'google id is linked onto the existing account')
assert.equal(linked?.avatarUrl, 'https://example.test/a.png')
assert.equal(linked?.name, 'Alice A.', 'linking does not clobber an existing name')
assert.equal(
  (await users.findByGoogleId(aliceGoogle))?.id,
  alice.id,
  'and the account is findable by it',
)

await users.setAvatar(bob.id, 'https://example.test/bob2.png')
assert.equal((await users.findById(bob.id))?.avatarUrl, 'https://example.test/bob2.png')

const firstClaim = await users.claimStripeCustomerId(alice.id, 'cus_first')
assert.equal(firstClaim, 'cus_first', 'the first claim wins')
const secondClaim = await users.claimStripeCustomerId(alice.id, 'cus_second')
assert.equal(secondClaim, 'cus_first', 'a later claim keeps whichever landed first')
assert.equal(
  (await users.findById(alice.id))?.stripeCustomerId,
  'cus_first',
  'and the account still points at it',
)

const owner = oid()
const stranger = oid()
const tierForVideo = oid()

const made = await videos.create({
  id: oid(),
  title: 'Contract video',
  description: 'first',
  url: 's3://bucket/videos/one.mp4',
  uploadedBy: owner,
  durationSeconds: 42,
  visibility: 'public',
  requiredTierId: null,
  priceCents: null,
  adsEnabled: true,
})
assert.equal(made.title, 'Contract video')
assert.equal(made.visibility, 'public')
assert.equal(made.likeCount, 0)
assert.equal(made.viewCount, 0)
assert.equal(made.transcode.status, 'pending', 'a new video starts pending transcode')
assert.equal(made.transcode.attempts, 0)

const readBack = await videos.findById(made.id)
assert.equal(readBack?.url, 's3://bucket/videos/one.mp4', 'findById reads it back')
assert.equal(readBack?.durationSeconds, 42)
assert.equal(readBack?.uploadedBy, owner)
assert.ok(readBack?.createdAt instanceof Date, 'and carries a creation date')
assert.equal(await videos.findById(oid()), null, 'an unknown id is null')

await sleep(5)
const privateVideo = await videos.create({
  id: oid(),
  title: 'Contract private',
  description: '',
  url: 's3://bucket/videos/two.mp4',
  uploadedBy: owner,
  durationSeconds: 10,
  visibility: 'private',
  requiredTierId: null,
  priceCents: null,
  adsEnabled: false,
})

await sleep(5)
const gated = await videos.create({
  id: oid(),
  title: 'Contract gated',
  description: '',
  url: 's3://bucket/videos/three.mp4',
  uploadedBy: owner,
  durationSeconds: 10,
  visibility: 'subscriber',
  requiredTierId: tierForVideo,
  priceCents: null,
  adsEnabled: false,
})

const ownerSees = await videos.listVisible(owner, 50)
const ownerIds = ownerSees.map((v) => v.id)
assert.ok(ownerIds.includes(privateVideo.id), 'the owner sees their own private video')

const strangerSees = await videos.listVisible(stranger, 50)
assert.ok(
  !strangerSees.map((v) => v.id).includes(privateVideo.id),
  'a stranger does not see a private video',
)
assert.ok(
  strangerSees.map((v) => v.id).includes(made.id),
  'but does see a public one',
)
assert.ok(
  !(await videos.listVisible(null, 50)).map((v) => v.id).includes(privateVideo.id),
  'and neither does an anonymous viewer',
)

const mineNewestFirst = ownerSees.filter((v) => v.uploadedBy === owner).map((v) => v.id)
assert.deepEqual(
  mineNewestFirst,
  [gated.id, privateVideo.id, made.id],
  'listVisible returns newest first',
)

const byCreator = await videos.listVisibleByCreators(stranger, [owner], 50)
assert.deepEqual(
  byCreator.map((v) => v.id),
  [gated.id, made.id],
  'listVisibleByCreators hides private rows and keeps order',
)
assert.deepEqual(
  await videos.listVisibleByCreators(stranger, [], 50),
  [],
  'no creators means no rows',
)

const recent = await videos.listVisibleSince(owner, new Date(Date.now() - 60_000), 50)
assert.ok(recent.map((v) => v.id).includes(made.id), 'listVisibleSince finds a fresh row')
assert.deepEqual(
  await videos.listVisibleSince(owner, new Date(Date.now() + 60_000), 50),
  [],
  'and nothing after a future cutoff',
)

const everyRow = await videos.listByCreator(owner, 50)
assert.equal(everyRow.length, 3, 'listByCreator returns every row, private included')

assert.deepEqual(
  [...(await videos.countByTier([tierForVideo, oid()])).entries()],
  [[tierForVideo, 1]],
  'countByTier counts videos gated behind each tier',
)
assert.equal((await videos.countByTier([])).size, 0, 'countByTier tolerates empty')

assert.equal(
  await videos.updateDetails(made.id, stranger, { title: 'Stolen', description: 'x' }),
  null,
  'a non-owner cannot edit',
)
const editedVideo = await videos.updateDetails(made.id, owner, {
  title: 'Contract video edited',
  description: 'second',
})
assert.equal(editedVideo?.title, 'Contract video edited', 'the owner can edit')
assert.equal(editedVideo?.description, 'second')
assert.equal(editedVideo?.url, 's3://bucket/videos/one.mp4', 'untouched fields survive')

assert.equal(
  await videos.updateGate(made.id, stranger, {
    visibility: 'private',
    requiredTierId: null,
    priceCents: null,
    adsEnabled: false,
  }),
  null,
  'a non-owner cannot change the gate',
)
const gatedNow = await videos.updateGate(made.id, owner, {
  visibility: 'buyer',
  requiredTierId: null,
  priceCents: 250,
  adsEnabled: false,
})
assert.equal(gatedNow?.visibility, 'buyer')
assert.equal(gatedNow?.priceCents, 250)
assert.equal(gatedNow?.adsEnabled, false)

await videos.incrementView(made.id)
await videos.incrementView(made.id)
assert.equal((await videos.findById(made.id))?.viewCount, 2, 'views accumulate')
assert.equal(await videos.incrementLike(made.id, 1), 1, 'a like returns the new count')
assert.equal(await videos.incrementLike(made.id, 1), 2)
assert.equal(await videos.incrementLike(made.id, -1), 1, 'and an unlike takes it back')
assert.equal(await videos.incrementShare(made.id), 1, 'a share returns the new count')

const worker = 'contract-worker-1'
const other = 'contract-worker-2'

const claimed = await videos.claimNext(worker, 60_000, 5)
assert.ok(claimed, 'a pending video is claimable')
assert.ok(claimed.prefix, 'a claim mints a prefix')
assert.equal(claimed.attempts, 1, 'and counts the attempt')
assert.ok(claimed.url.startsWith('s3://'), 'and carries the source url')

const afterClaim = await videos.findById(claimed.id)
assert.equal(afterClaim?.transcode.status, 'processing')
assert.equal(afterClaim?.transcode.workerId, worker)

assert.equal(
  await videos.renewClaim(claimed.id, other, 60_000),
  false,
  'another worker cannot renew a lease it does not hold',
)
assert.equal(await videos.renewClaim(claimed.id, worker, 60_000), true, 'the holder can')

assert.equal(
  await videos.completeTranscode(claimed.id, other, {
    hlsUrl: 'x',
    dashUrl: 'x',
    renditions: [],
    sourceWidth: 0,
    sourceHeight: 0,
    durationSeconds: 0,
  }),
  false,
  'another worker cannot complete it',
)

assert.equal(
  await videos.completeTranscode(claimed.id, worker, {
    hlsUrl: 's3://bucket/hls.m3u8',
    dashUrl: 's3://bucket/dash.mpd',
    renditions: [{ width: 640, height: 360, bitrateKbps: 800 }],
    sourceWidth: 1920,
    sourceHeight: 1080,
    durationSeconds: 99,
  }),
  true,
  'the holder can',
)
const done = await videos.findById(claimed.id)
assert.equal(done?.transcode.status, 'ready')
assert.equal(done?.transcode.hlsUrl, 's3://bucket/hls.m3u8')
assert.equal(done?.transcode.renditions.length, 1)
assert.equal(done?.transcode.renditions[0].height, 360)
assert.equal(done?.transcode.sourceWidth, 1920)
assert.equal(done?.durationSeconds, 99, 'a probed duration overwrites the uploaded one')

const nextClaim = await videos.claimNext(worker, 60_000, 5)
assert.ok(nextClaim, 'the next pending video is claimable')
assert.notEqual(nextClaim.id, claimed.id, 'and it is a different one')
assert.equal(
  await videos.failTranscode(nextClaim.id, other, false, new Date(), 'nope'),
  false,
  'another worker cannot fail it',
)
assert.equal(
  await videos.failTranscode(nextClaim.id, worker, false, new Date(Date.now() + 1000), 'boom'),
  true,
)
const failed = await videos.findById(nextClaim.id)
assert.equal(failed?.transcode.status, 'pending', 'a retryable failure goes back to pending')
assert.equal(failed?.transcode.error, 'boom')
assert.equal(failed?.transcode.finishedAt, null, 'and is not finished')

const third = await videos.claimNext(worker, 60_000, 5)
assert.ok(third)
assert.equal(await videos.skipTranscode(third.id, worker, 'too big'), true)
const skipped = await videos.findById(third.id)
assert.equal(skipped?.transcode.status, 'skipped')
assert.equal(skipped?.transcode.error, 'too big')

assert.equal(await videos.deleteOwned(made.id, stranger), null, 'a non-owner cannot delete')
const deleted = await videos.deleteOwned(made.id, owner)
assert.equal(deleted?.id, made.id, 'the owner can delete')
assert.equal(await videos.findById(made.id), null, 'and it is gone')

const ledgerCreator = oid()
const ledgerVideo = oid()
const buyer = oid()
const session = `cs_test_${tag}`

assert.deepEqual(await tips.listByCreator(ledgerCreator), [], 'no tips yet')

await tips.recordBySession(session, {
  supporterId: oid(),
  creatorId: ledgerCreator,
  videoId: ledgerVideo,
  amountCents: 500,
  currency: 'usd',
})
await tips.recordBySession(session, {
  supporterId: oid(),
  creatorId: ledgerCreator,
  videoId: ledgerVideo,
  amountCents: 500,
  currency: 'usd',
})

const tipRows = await tips.listByCreator(ledgerCreator)
assert.equal(tipRows.length, 1, 'a replayed webhook settles the same tip row')
assert.equal(tipRows[0].amountCents, 500)
assert.equal(tipRows[0].videoId, ledgerVideo)
assert.equal(tipRows[0].currency, 'usd')
assert.ok(tipRows[0].at instanceof Date, 'and carries the date it landed')

await tips.recordBySession(`${session}-channel`, {
  supporterId: oid(),
  creatorId: ledgerCreator,
  videoId: null,
  amountCents: 250,
  currency: 'usd',
})
const withDonation = await tips.listByCreator(ledgerCreator)
assert.equal(withDonation.length, 2)
assert.ok(
  withDonation.some((row) => row.videoId === null),
  'a channel donation carries no video',
)

assert.equal(await videoPurchases.existsForBuyer(buyer, ledgerVideo), false, 'not bought yet')
const purchaseSession = `cs_buy_${tag}`
await videoPurchases.recordBySession(purchaseSession, {
  buyerId: buyer,
  creatorId: ledgerCreator,
  videoId: ledgerVideo,
  amountCents: 250,
  currency: 'usd',
})
await videoPurchases.recordBySession(purchaseSession, {
  buyerId: buyer,
  creatorId: ledgerCreator,
  videoId: ledgerVideo,
  amountCents: 250,
  currency: 'usd',
})
assert.equal(await videoPurchases.existsForBuyer(buyer, ledgerVideo), true, 'now it is bought')
assert.equal(
  (await videoPurchases.listByCreator(ledgerCreator)).length,
  1,
  'a replayed webhook settles the same purchase row',
)
assert.deepEqual(
  [...(await videoPurchases.purchasedVideoIds(buyer, [ledgerVideo, oid()]))],
  [ledgerVideo],
  'purchasedVideoIds reports only what was bought',
)
assert.equal(
  (await videoPurchases.purchasedVideoIds(oid(), [ledgerVideo])).size,
  0,
  'and nothing for another buyer',
)
assert.equal((await videoPurchases.purchasedVideoIds(buyer, [])).size, 0, 'empty in, empty out')

const paidAt = new Date(Date.now() - 86_400_000)
const invoiceId = `in_${tag}`
await subscriptionInvoices.recordByInvoiceId(invoiceId, {
  subscriberId: oid(),
  creatorId: ledgerCreator,
  stripeSubscriptionId: `sub_${tag}`,
  tierId: null,
  tierName: '',
  amountPaidCents: 499,
  currency: 'usd',
  billingReason: 'subscription_cycle',
  paidAt,
  periodStart: null,
  periodEnd: null,
})
await subscriptionInvoices.recordByInvoiceId(invoiceId, {
  subscriberId: oid(),
  creatorId: ledgerCreator,
  stripeSubscriptionId: `sub_${tag}`,
  tierId: null,
  tierName: '',
  amountPaidCents: 499,
  currency: 'usd',
  billingReason: 'subscription_cycle',
  paidAt,
  periodStart: null,
  periodEnd: null,
})
const invoiceRows = await subscriptionInvoices.listByCreator(ledgerCreator)
assert.equal(invoiceRows.length, 1, 'a replayed invoice settles the same row')
assert.equal(invoiceRows[0].amountCents, 499, 'and reports amountPaid as the amount')
assert.equal(invoiceRows[0].at.getTime(), paidAt.getTime(), 'dated by when it was paid')
assert.equal(invoiceRows[0].videoId, null, 'a subscription belongs to no video')

const impressionViewer = oid()
const impressionAd = oid()
const dedupe = `${impressionViewer}:${ledgerVideo}:${impressionAd}:1`

await adImpressions.record({
  adId: impressionAd,
  videoId: ledgerVideo,
  creatorId: ledgerCreator,
  viewerId: impressionViewer,
  shownAt: new Date(),
  dedupeKey: dedupe,
})
await adImpressions.record({
  adId: impressionAd,
  videoId: ledgerVideo,
  creatorId: ledgerCreator,
  viewerId: impressionViewer,
  shownAt: new Date(),
  dedupeKey: dedupe,
})
assert.equal(
  (await adImpressions.listByCreator(ledgerCreator)).length,
  1,
  'the same viewer inside one window counts once',
)

await adImpressions.record({
  adId: impressionAd,
  videoId: ledgerVideo,
  creatorId: ledgerCreator,
  viewerId: null,
  shownAt: new Date(),
  dedupeKey: null,
})
await adImpressions.record({
  adId: impressionAd,
  videoId: ledgerVideo,
  creatorId: ledgerCreator,
  viewerId: null,
  shownAt: new Date(),
  dedupeKey: null,
})
assert.equal(
  (await adImpressions.listByCreator(ledgerCreator)).length,
  3,
  'anonymous impressions are each their own row',
)

console.log(`repo contract (${backend}): all assertions passed`)
process.exit(0)
