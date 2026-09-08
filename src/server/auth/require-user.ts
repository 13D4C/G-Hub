import { AUTH_ERRORS } from '@/lib/auth-errors'
import { useAuthSession } from '@/server/auth/session'

/**
 * The signed-in user's id, or `null` when the request carries no session cookie.
 * Use in read handlers that render differently for a signed-in viewer.
 */
export async function getUserId(): Promise<string | null> {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- not a React hook; see src/server/auth/session.ts
  const session = await useAuthSession()
  return session.data.userId ?? null
}

/**
 * The signed-in user's id, or a user-facing rejection. Call this first in a mutation
 * handler so an anonymous caller is turned away before touching Mongo.
 *
 * The session cookie is sealed with SESSION_SECRET (see `src/server/auth/session.ts`),
 * so `userId` cannot be forged and is trusted without a Mongo round trip. The cost is
 * that a row can outlive the account that wrote it, so readers that join back to
 * `user` must treat a missing author as expected — see `listComments`.
 */
export async function requireUserId(): Promise<string> {
  const userId = await getUserId()
  if (!userId) throw new Error(AUTH_ERRORS.authRequired)
  return userId
}
