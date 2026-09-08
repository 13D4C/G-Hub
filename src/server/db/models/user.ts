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
  },
  { timestamps: true },
)

export type User = InferSchemaType<typeof userSchema> & { _id: mongoose.Types.ObjectId }

export const UserModel: Model<User> =
  (mongoose.models.user as Model<User>) ?? mongoose.model<User>('user', userSchema)
