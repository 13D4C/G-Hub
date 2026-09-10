import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { CHANNEL_ERRORS } from '@/lib/channel-errors'
import { INTERACTION_ERRORS } from '@/lib/interaction-errors'
import { requireUserId } from '@/server/auth/require-user'
import {
  MAX_TIERS_PER_CREATOR,
  MembershipTierModel,
  TIER_DESCRIPTION_MAX_LENGTH,
  TIER_NAME_MAX_LENGTH,
} from '@/server/db/models/membership-tier'
import { UserModel } from '@/server/db/models/user'
import { VideoModel } from '@/server/db/models/video'
import { connectToDatabase } from '@/server/db/mongoose'
import { readLadder, type MembershipTierView } from '@/server/lib/tier-ladder'

/**
 * A creator's membership ladder: creating the rungs, pricing them, and mapping
 * uploaded videos onto them.
 *
 * Every mutation here takes its creator from the session and never from an argument,
 * so a caller can only ever edit their own ladder — the same shape as
 * `updateChannelSettings`, and the reason none of these need a separate ownership
 * read.
 *
 * Nothing here grants or revokes access on its own. The gate is
 * `requirePlayableVideo`; these functions only move the posts it reads.
 *
 * Only `createServerFn` values and types are exported from this file, as from every
 * module in `src/server/functions/`. Vite strips a server function's body from the
 * client bundle but leaves an ordinary export alone, so a plain exported helper here
 * would drag the Mongoose models it touches into the browser — see
 * `src/server/lib/tier-ladder.ts`, where `readLadder` lives for exactly that reason.
 */

/** Same rationale as `interactions.ts`: a junk id must be a clean rejection. */
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')

/**
 * Re-exported so callers can name the shape these functions return without reaching
 * past them. `export type` is erased at compile time, so this pulls nothing from
 * `server/lib` into a client bundle.
 */
export type { MembershipTierView }

/** Mongo's duplicate-key error, raised here by the unique `(creatorId, name)` index. */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000
}

/**
 * The signed-in creator's own ladder. Distinct from the copy `getChannel` returns
 * because the upload form and the video table need it without a `creatorId` — and
 * because those callers are always the owner, so there is no viewer to shape it for.
 */
export const listMyMembershipTiers = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<MembershipTierView>> => {
    const creatorId = await requireUserId()
    await connectToDatabase()
    return readLadder(creatorId)
  },
)

const tierInputSchema = z.object({
  name: z.string().trim().min(1).max(TIER_NAME_MAX_LENGTH),
  description: z.string().trim().max(TIER_DESCRIPTION_MAX_LENGTH),
  /**
   * Minor units, floored at Stripe's minimum and capped so a fat-fingered price
   * cannot bill a subscriber hundreds of dollars — the same bounds
   * `updateChannelSettings` puts on the channel-level price. Unlike that one, zero
   * is not allowed: a tier exists to be sold, and a creator who wants to stop
   * selling one archives it.
   */
  priceCents: z.number().int().min(50).max(500_000),
  rank: z.number().int().min(0).max(999),
})

const updateTierSchema = tierInputSchema.extend({ tierId: objectId })
const archiveTierSchema = z.object({ tierId: objectId })

/**
 * Add a rung to the signed-in creator's ladder.
 *
 * The cap is on *live* tiers, so a creator who has archived old ones is not
 * permanently out of room.
 */
export const createMembershipTier = createServerFn({ method: 'POST' })
  .validator(tierInputSchema)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const creatorId = await requireUserId()
    await connectToDatabase()

    const live = await MembershipTierModel.countDocuments({ creatorId, active: true })
    if (live >= MAX_TIERS_PER_CREATOR) throw new Error(CHANNEL_ERRORS.tierLimitReached)

    // Tiers are priced in the channel's currency rather than each in its own: Stripe
    // bills one subscription per channel, and a ladder priced in two currencies is a
    // ladder a viewer cannot compare.
    const creator = await UserModel.findById(creatorId).select('channelCurrency').lean()

    try {
      const tier = await MembershipTierModel.create({
        creatorId,
        ...data,
        currency: creator?.channelCurrency || 'usd',
      })
      return { id: String(tier._id) }
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new Error(CHANNEL_ERRORS.duplicateTierName)
      throw err
    }
  })

/**
 * Rename, reprice or reorder one rung.
 *
 * A price change applies to new subscribers only — Stripe keeps billing everyone
 * already on this tier the amount they agreed to, and `channelsubscription`
 * snapshots it, exactly as a channel-level price change behaves.
 *
 * A *rank* change is different and takes effect immediately for everyone: the gate
 * reads the tier's rank live rather than a snapshot, so demoting Gold below Silver
 * moves every Gold subscriber down with it. That is what reordering a ladder means,
 * and the alternative — subscribers frozen at the rank they bought — would leave a
 * creator unable to correct their own mistake.
 */
export const updateMembershipTier = createServerFn({ method: 'POST' })
  .validator(updateTierSchema)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const creatorId = await requireUserId()
    await connectToDatabase()

    const { tierId, ...fields } = data

    let updated
    try {
      // Ownership lives in the filter rather than in a separate read, so there is no
      // window between the check and the write.
      updated = await MembershipTierModel.findOneAndUpdate(
        { _id: tierId, creatorId, active: true },
        { $set: fields },
        { returnDocument: 'after' },
      )
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new Error(CHANNEL_ERRORS.duplicateTierName)
      throw err
    }
    if (!updated) throw new Error(CHANNEL_ERRORS.tierNotFound)

    return { id: String(updated._id) }
  })

/**
 * Retire a rung: it stops being offered to new subscribers and leaves the dropdown
 * that gates videos.
 *
 * Archived, never deleted. Existing subscribers keep the access they are paying for
 * until their period lapses, and any video still gated behind it keeps a gate that
 * resolves — see the `active` field on the model. Their Stripe subscriptions are
 * untouched: cancelling one is the subscriber's to do from the billing portal, and
 * cancelling paid subscriptions from a creator's "remove tier" button would be a
 * refund nobody asked for.
 */
export const archiveMembershipTier = createServerFn({ method: 'POST' })
  .validator(archiveTierSchema)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const creatorId = await requireUserId()
    await connectToDatabase()

    const archived = await MembershipTierModel.findOneAndUpdate(
      { _id: data.tierId, creatorId, active: true },
      { $set: { active: false } },
    )
    if (!archived) throw new Error(CHANNEL_ERRORS.tierNotFound)

    return { id: data.tierId }
  })

const setVideoTierSchema = z.object({
  videoId: objectId,
  /** Null clears the gate: any active subscriber may watch. */
  tierId: objectId.nullable(),
})

/**
 * Map one of the creator's own uploaded videos onto a tier — the third acceptance
 * criterion, and the only way to gate a video after it has been uploaded.
 *
 * Setting a tier implies the video is premium, so this flips `visibility` to
 * `private` as well, and turns preroll ads off for the same reason `createVideo`
 * does: a public video carrying a tier gate is a contradiction the gate would
 * resolve in the viewer's favour, quietly giving away what the creator just priced.
 *
 * Clearing the tier deliberately does *not* flip visibility back. "Any subscriber"
 * is a valid premium setting, so guessing that a cleared gate means "make it public"
 * would un-paywall a video on a click meant to widen it.
 */
export const setVideoTier = createServerFn({ method: 'POST' })
  .validator(setVideoTierSchema)
  .handler(async ({ data }): Promise<{ videoId: string; tierId: string | null }> => {
    const creatorId = await requireUserId()
    await connectToDatabase()

    if (data.tierId) {
      const tier = await MembershipTierModel.findOne({
        _id: data.tierId,
        creatorId,
        active: true,
      })
        .select('_id')
        .lean()
      // Rejected as "no longer exists" rather than "not yours": whether another
      // creator's tier exists is not this caller's business.
      if (!tier) throw new Error(CHANNEL_ERRORS.tierNotYours)
    }

    const update = data.tierId
      ? { requiredTierId: data.tierId, visibility: 'private', adsEnabled: false }
      : { requiredTierId: null }

    const video = await VideoModel.findOneAndUpdate(
      { _id: data.videoId, uploadedBy: creatorId },
      { $set: update },
    )
    // Does not distinguish "gone" from "not yours", same as `deleteComment`.
    if (!video) throw new Error(INTERACTION_ERRORS.videoNotFound)

    return { videoId: data.videoId, tierId: data.tierId }
  })
