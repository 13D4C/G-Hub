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
    // Every account is potentially a channel; it only becomes one a viewer can
    // subscribe to once `subscriptionPriceCents` is above zero. There is no separate
    // `channel` collection because a channel has no identity of its own — it is the
    // creator, and a second collection would only be a second name for the same row.
    channelName: { type: String, default: '', trim: true },
    channelDescription: { type: String, default: '' },
    /**
     * Monthly price of this creator's channel subscription, in the minor unit of
     * `channelCurrency` (so 4900 = $49.00). Zero means the channel is not accepting
     * subscribers, which is the default for every account.
     */
    subscriptionPriceCents: { type: Number, default: 0, min: 0 },
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
