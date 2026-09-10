import mongoose, { type InferSchemaType, type Model } from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    // Absent for accounts that only ever signed in through Google.
    passwordHash: {
      type: String,
      required: function (this: { googleId?: string | null }) {
        return !this.googleId
      },
    },
    googleId: { type: String, unique: true, sparse: true },
    name: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },

    // --- Channel ---
    // Every account is potentially a channel; it becomes one a viewer can subscribe
    // to once it has at least one membership tier. There is no separate `channel`
    // collection because a channel has no identity of its own — it is the creator,
    // and a second collection would only be a second name for the same row.
    //
    // Nothing here prices anything. A channel used to carry a single
    // `subscriptionPriceCents`, which meant two systems could sell access to the
    // same videos and disagree about what a subscriber had bought; `membershiptier`
    // is now the only one. `scripts/migrate-channel-price-to-tier.ts` converted the
    // old field before it was dropped.
    channelName: { type: String, default: '', trim: true },
    channelDescription: { type: String, default: '' },
    /**
     * The currency every tier on this channel is priced in. It lives on the channel
     * rather than on each tier so a ladder cannot be half in dollars and half in
     * euros, which is a ladder a viewer cannot compare.
     */
    channelCurrency: { type: String, default: 'usd', lowercase: true, trim: true },

    // --- Billing ---
    /**
     * This account's Stripe customer, created on its first checkout and reused for
     * every later one. It lives on the user rather than on a subscription row
     * because a viewer subscribes to many channels but is one customer.
     */
    stripeCustomerId: { type: String, default: '', index: true },
  },
  { timestamps: true },
)

export type User = InferSchemaType<typeof userSchema> & { _id: mongoose.Types.ObjectId }

export const UserModel: Model<User> =
  (mongoose.models.user as Model<User>) ?? mongoose.model<User>('user', userSchema)
