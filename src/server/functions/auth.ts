import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { AUTH_ERRORS } from '@/lib/auth-errors'
import { isAllowedEmail } from '@/lib/email-domain'
import { users } from '@/server/data'
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

function toPublicUser(user: { id: string; email: string; name: string; avatarUrl: string }) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
  }
}

export const register = createServerFn({ method: 'POST' })
  .validator(registerSchema)
  .handler(async ({ data }) => {
    if (!isAllowedEmail(data.email)) throw new Error(AUTH_ERRORS.emailDomain)

    const existing = await users.findByEmail(data.email)
    if (existing) {
      throw new Error(AUTH_ERRORS.emailTaken)
    }

    const passwordHash = await hashPassword(data.password)
    const user = await users.create({
      email: data.email,
      passwordHash,
      name: data.name ?? '',
    })

    const session = await useAuthSession()
    await session.update({ userId: user.id })

    return toPublicUser(user)
  })

export const login = createServerFn({ method: 'POST' })
  .validator(loginSchema)
  .handler(async ({ data }) => {
    if (!isAllowedEmail(data.email)) throw new Error(AUTH_ERRORS.emailDomain)

    const user = await users.findByEmail(data.email)
    // A Google-only account has no passwordHash, so password login must not match it.
    if (!user?.passwordHash || !(await verifyPassword(data.password, user.passwordHash))) {
      throw new Error(AUTH_ERRORS.invalidCredentials)
    }

    const session = await useAuthSession()
    await session.update({ userId: user.id })

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

  const user = await users.findById(userId)
  if (!user) return null

  return toPublicUser(user)
})
