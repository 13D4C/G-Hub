import { queryOptions } from '@tanstack/react-query'
import { isUserFacingAuthError } from '@/lib/auth-errors'
import { isUserFacingChannelError } from '@/lib/channel-errors'
import { isUserFacingInteractionError } from '@/lib/interaction-errors'
import { isUserFacingVideoError } from '@/lib/video-errors'
import { me } from '@/server/functions/auth'

/** The signed-in user (or `null`), shared by the header and the auth route guards. */
export const meQueryOptions = queryOptions({
  queryKey: ['me'],
  queryFn: () => me(),
  staleTime: 60_000,
})

/** Reasons the Google callback can hand back via `?authError=` on the login page. */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'You cancelled the Google sign-in.',
  state_mismatch: 'That sign-in link expired. Please try again.',
  invalid_callback: 'That sign-in link expired. Please try again.',
  email_not_verified: 'Your Google email address is not verified.',
  google_sign_in_failed: 'Google sign-in failed. Please try again.',
}

export function describeAuthError(code: string | undefined): string | undefined {
  if (!code) return undefined
  return OAUTH_ERROR_MESSAGES[code] ?? 'Sign-in failed. Please try again.'
}

/**
 * Server function rejections arrive as plain `Error`s with the server's message
 * intact, so only the messages we deliberately surface are shown; everything else
 * (misconfiguration, database errors) collapses to `fallback`.
 */
export function describeMutationError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : ''
  return isUserFacingAuthError(message) ||
    isUserFacingInteractionError(message) ||
    isUserFacingVideoError(message) ||
    isUserFacingChannelError(message)
    ? message
    : fallback
}
