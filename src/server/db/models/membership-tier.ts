import mongoose, { type InferSchemaType, type Model } from 'mongoose'

/**
 * One rung of a creator's membership ladder — "Silver", "Gold", "VIP" — priced
 * independently and sold through its own Checkout.
 *
 * A tier belongs to a creator, not to a channel collection, for the same reason
 * `user.channelName` does: a channel has no identity of its own, it is the creator.
 *
 * Tiers are ordered by `rank`, not by price. A creator is free to price a higher
 * rung lower during a promotion, and access must not quietly follow the money.
 */

/** Also mirrored in `src/lib/membership-tiers.ts` for the client to read. */
export const MAX_TIERS_PER_CREATOR = 10
export const TIER_NAME_MAX_LENGTH = 40
export const TIER_DESCRIPTION_MAX_LENGTH = 300

const membershipTierSchema = new mongoose.Schema(
  {
    creatorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: TIER_NAME_MAX_LENGTH },
    description: { type: String, default: '', maxlength: TIER_DESCRIPTION_MAX_LENGTH },
    /**
     * Monthly price in the minor unit of `currency` (4900 = $49.00). Floored at
     * Stripe's minimum chargeable amount: below it Checkout rejects the session and
     * the viewer, not the creator, is the one who sees the error.
     */
    priceCents: { type: Number, required: true, min: 50 },
    currency: { type: String, default: 'usd', lowercase: true, trim: true },
    /**
     * Where this rung sits in the ladder. Higher unlocks lower: a Gold subscriber
     * (rank 2) can watch anything gated behind Silver (rank 1), which is the whole
     * point of tiers rather than three unrelated subscriptions.
     *
     * Ranks need not be distinct — two tiers sharing a rank are two names for the
     * same level of access, which is a legitimate thing to sell.
     */
    rank: { type: Number, required: true, min: 0 },
    /**
     * Archived rather than deleted. A subscriber's row points at the tier they pay
     * for, and a video's gate points at the tier it needs; hard-deleting either
     * target would turn a paying viewer's access into a dangling reference. Archived
     * tiers stop being offered but keep resolving for everyone who already holds one.
     */
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
)

// The creator's ladder, read in order by the channel page and the tier editor.
membershipTierSchema.index({ creatorId: 1, rank: 1 })

// Two live tiers with the same name would be indistinguishable in every dropdown
// that maps a video to one. Partial, so archiving "Gold" frees the name again.
membershipTierSchema.index(
  { creatorId: 1, name: 1 },
  { unique: true, partialFilterExpression: { active: true } },
)

export type MembershipTier = InferSchemaType<typeof membershipTierSchema> & {
  _id: mongoose.Types.ObjectId
}

export const MembershipTierModel: Model<MembershipTier> =
  (mongoose.models.membershipTier as Model<MembershipTier>) ??
  mongoose.model<MembershipTier>('membershipTier', membershipTierSchema)
