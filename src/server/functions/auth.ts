import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { AUTH_ERRORS } from '@/lib/auth-errors'
import { connectToDatabase } from '@/server/db/mongoose'
import { UserModel } from '@/server/db/models/user'
import { hashPassword, verifyPassword } from '@/server/auth/password'
import { useAuthSession } from '@/server/auth/session'

const registerSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(100).optional(),
})

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
})

function toPublicUser(user: { _id: unknown; email: string; name?: string }) {
  return {
    id: String(user._id),
    email: user.email,
    name: user.name ?? '',
  }
}

export const register = createServerFn({ method: 'POST' })
  .validator(registerSchema)
  .handler(async ({ data }) => {
    await connectToDatabase()

    const existing = await UserModel.findOne({ email: data.email }).lean()
    if (existing) {
      throw new Error(AUTH_ERRORS.emailTaken)
    }

    const passwordHash = await hashPassword(data.password)
    const user = await UserModel.create({
      email: data.email,
      passwordHash,
      name: data.name ?? '',
    })

    const session = await useAuthSession()
    await session.update({ userId: String(user._id) })

    return toPublicUser(user)
  })

export const login = createServerFn({ method: 'POST' })
  .validator(loginSchema)
  .handler(async ({ data }) => {
    await connectToDatabase()

    const user = await UserModel.findOne({ email: data.email })
    // A Google-only account has no passwordHash, so password login must not match it.
    if (!user?.passwordHash || !(await verifyPassword(data.password, user.passwordHash))) {
      throw new Error(AUTH_ERRORS.invalidCredentials)
    }

    const session = await useAuthSession()
    await session.update({ userId: String(user._id) })

    return toPublicUser(user)
  })

export const logout = createServerFn({ method: 'POST' }).handler(async () => {
  const session = await useAuthSession()
  await session.clear()
  return { success: true }
})

export const me = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await useAuthSession()
  const userId = session.data.userId
  if (!userId) return null

  await connectToDatabase()
  const user = await UserModel.findById(userId).lean()
  if (!user) return null

  return toPublicUser(user)
})
