/**
 * Integration check for the membership-tier gate, against the local Mongo in
 * MONGODB_URI.
 *
 * Run: npm run test:membership-tier
 *
 * `scripts/test-tier-access.ts` covers the ladder predicate in isolation; this
 * covers the thing it is *for* — that `requirePlayableVideo` lets a Gold subscriber
 * into a Silver video, keeps a Silver subscriber out of a Gold one, and tells the
 * two failures apart so the UI can say "subscribe" or "upgrade". It is the
 * `test-channel-gate.ts` of tiers and is deliberately shaped the same way.
 *
 * No Stripe calls: subscription rows are written directly, the way
 * `syncSubscription` writes them.
 *
 * Creates its own throwaway users/tiers/videos and deletes them again, so it is safe
 * to run against a dev database.
 */
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { INTERACTION_ERRORS } from '../src/lib/interaction-errors.ts'
import { ChannelSubscriptionModel } from '../src/server/db/models/channel-subscription.ts'
import { MembershipTierModel } from '../src/server/db/models/membership-tier.ts'
import { UserModel } from '../src/server/db/models/user.ts'
import { VideoModel } from '../src/server/db/models/video.ts'
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import { requirePlayableVideo } from '../src/server/lib/entitlement.ts'

const tag = `tier-test-${Date.now()}`
const CUSTOMER = 'cus_tier_test'

/** The rejection `requirePlayableVideo` throws, or null when it let the viewer in. */
async function denial(videoId: string, viewerId: string | null): Promise<string | null> {
  try {
    await requirePlayableVideo(videoId, viewerId)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** An active subscription on a given rung, as the Stripe sync would have left it. */
async function subscribeAt(
  subscriberId: mongoose.Types.ObjectId,
  creatorId: mongoose.Types.ObjectId,
  tierId: mongoose.Types.ObjectId | null,
) {
  await ChannelSubscriptionModel.findOneAndUpdate(
    { subscriberId, creatorId },
    {
      stripeCustomerId: CUSTOMER,
      status: 'active',
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      tierId,
    },
    { upsert: true, setDefaultsOnInsert: true },
  )
}

async function main() {
  await connectToDatabase()

  const creator = await UserModel.create({
    email: `${tag}-creator@example.test`,
    googleId: `${tag}-creator`,
    channelName: 'Tier Test Channel',
    subscriptionPriceCents: 499,
  })
  const viewer = await UserModel.create({
    email: `${tag}-viewer@example.test`,
    googleId: `${tag}-viewer`,
  })

  const silver = await MembershipTierModel.create({
    creatorId: creator._id,
    name: `${tag} Silver`,
    priceCents: 499,
    rank: 1,
  })
  const gold = await MembershipTierModel.create({
    creatorId: creator._id,
    name: `${tag} Gold`,
    priceCents: 999,
    rank: 2,
  })

  const premium = async (title: string, requiredTierId: mongoose.Types.ObjectId | null) =>
    VideoModel.create({
      title: `${tag} ${title}`,
      url: `http://example.test/${title}.mp4`,
      visibility: 'subscriber',
      uploadedBy: creator._id,
      requiredTierId,
    })

  const anyTier = await premium('any', null)
  const silverOnly = await premium('silver', silver._id)
  const goldOnly = await premium('gold', gold._id)

  const viewerId = String(viewer._id)
  const creatorId = String(creator._id)
  const anyId = String(anyTier._id)
  const silverId = String(silverOnly._id)
  const goldId = String(goldOnly._id)

  // A stranger is stopped by the paywall before tiers are even consulted.
  for (const id of [anyId, silverId, goldId]) {
    assert.equal(await denial(id, viewerId), INTERACTION_ERRORS.subscriptionRequired)
  }

  // The creator holds every rung of their own ladder without buying one.
  for (const id of [anyId, silverId, goldId]) {
    assert.equal(await denial(id, creatorId), null, 'creator should watch their own videos')
  }

  // A channel-level subscription (no tier) predates the ladder: it opens the ungated
  // premium video and nothing that names a tier. Fail-closed, so adding tiers cannot
  // silently give away what the creator just put a price on.
  await subscribeAt(viewer._id, creator._id, null)
  assert.equal(await denial(anyId, viewerId), null, 'a plain subscription opens an ungated video')
  assert.equal(await denial(silverId, viewerId), INTERACTION_ERRORS.tierRequired)
  assert.equal(await denial(goldId, viewerId), INTERACTION_ERRORS.tierRequired)

  // Silver: its own videos and the ungated one, but not Gold's.
  await subscribeAt(viewer._id, creator._id, silver._id)
  assert.equal(await denial(anyId, viewerId), null)
  assert.equal(await denial(silverId, viewerId), null, 'Silver should watch Silver')
  assert.equal(
    await denial(goldId, viewerId),
    INTERACTION_ERRORS.tierRequired,
    'Silver must not reach Gold — and must be told to upgrade, not to subscribe',
  )

  // Gold: everything at or below it. This is what makes it a ladder rather than
  // three unrelated subscriptions.
  await subscribeAt(viewer._id, creator._id, gold._id)
  assert.equal(await denial(anyId, viewerId), null)
  assert.equal(await denial(silverId, viewerId), null, 'Gold should watch Silver')
  assert.equal(await denial(goldId, viewerId), null, 'Gold should watch Gold')

  // Reordering the ladder moves subscribers with it: the gate reads the rank live
  // rather than a snapshot taken at checkout.
  await MembershipTierModel.updateOne({ _id: gold._id }, { rank: 0 })
  assert.equal(
    await denial(silverId, viewerId),
    INTERACTION_ERRORS.tierRequired,
    'a demoted Gold no longer outranks Silver',
  )
  assert.equal(await denial(goldId, viewerId), null, 'a tier always opens its own gate')
  await MembershipTierModel.updateOne({ _id: gold._id }, { rank: 2 })

  // Archiving a tier retires it from the shop window without revoking what people
  // are already paying for.
  await MembershipTierModel.updateOne({ _id: silver._id }, { active: false })
  assert.equal(
    await denial(silverId, viewerId),
    null,
    'an archived tier still resolves for a video gated behind it',
  )
  await subscribeAt(viewer._id, creator._id, silver._id)
  assert.equal(
    await denial(silverId, viewerId),
    null,
    'a subscriber on an archived tier keeps their access',
  )
  await MembershipTierModel.updateOne({ _id: silver._id }, { active: true })

  // Tiers are a channel's own ladder: holding Gold here buys nothing next door, even
  // from a tier that happens to sit at the same rank.
  const other = await UserModel.create({
    email: `${tag}-other@example.test`,
    googleId: `${tag}-other`,
    channelName: 'Someone Else',
  })
  const otherGold = await MembershipTierModel.create({
    creatorId: other._id,
    name: `${tag} Gold`,
    priceCents: 999,
    rank: 2,
  })
  const otherVideo = await premium('other', otherGold._id)
  await VideoModel.updateOne({ _id: otherVideo._id }, { uploadedBy: other._id })
  await subscribeAt(viewer._id, creator._id, gold._id)
  assert.equal(
    await denial(String(otherVideo._id), viewerId),
    INTERACTION_ERRORS.subscriptionRequired,
    'a tier on one channel must not unlock another',
  )

  // Visibility outranks the ladder: a private video is the uploader's alone, and no
  // tier — however high, however expensive — is a way in.
  const hidden = await premium('hidden', gold._id)
  await VideoModel.updateOne({ _id: hidden._id }, { visibility: 'private' })
  await subscribeAt(viewer._id, creator._id, gold._id)
  assert.equal(
    await denial(String(hidden._id), viewerId),
    INTERACTION_ERRORS.videoNotFound,
    'no tier opens a private video',
  )
  assert.equal(
    await denial(String(hidden._id), creatorId),
    null,
    'the uploader still watches their own private video',
  )

  // A lapsed period closes every rung at once — the entitlement check runs first.
  await ChannelSubscriptionModel.updateOne(
    { subscriberId: viewer._id, creatorId: creator._id },
    { currentPeriodEnd: new Date(Date.now() - 86_400_000) },
  )
  assert.equal(await denial(goldId, viewerId), INTERACTION_ERRORS.subscriptionRequired)
  assert.equal(await denial(anyId, viewerId), INTERACTION_ERRORS.subscriptionRequired)

  console.log('membership tier: all checks passed')
}

main()
  .catch((err) => {
    console.error('membership tier FAILED:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    // Best effort: a failed run should still not leave test rows behind.
    await Promise.all([
      UserModel.deleteMany({ email: new RegExp(`^${tag}-`) }),
      VideoModel.deleteMany({ title: new RegExp(`^${tag} `) }),
      MembershipTierModel.deleteMany({ name: new RegExp(`^${tag} `) }),
      ChannelSubscriptionModel.deleteMany({ stripeCustomerId: CUSTOMER }),
    ]).catch(() => {})
    await mongoose.disconnect()
  })
