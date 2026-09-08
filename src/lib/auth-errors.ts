/**
 * Messages the auth server functions reject with. Shared so the client can tell a
 * user-facing rejection apart from an unexpected server error, whose text (missing
 * env vars, database outages, ...) must never be rendered in the UI.
 */
export const AUTH_ERRORS = {
  emailTaken: 'An account with this email already exists.',
  invalidCredentials: 'Invalid email or password.',
  authRequired: 'Please sign in to continue.',
} as const

const USER_FACING = new Set<string>(Object.values(AUTH_ERRORS))

export function isUserFacingAuthError(message: string): boolean {
  return USER_FACING.has(message)
}
