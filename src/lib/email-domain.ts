export const ALLOWED_EMAIL_DOMAIN = 'kmitl.ac.th'

const SUFFIX = `@${ALLOWED_EMAIL_DOMAIN}`

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const normalized = email.trim().toLowerCase()
  if (!normalized.endsWith(SUFFIX)) return false
  const local = normalized.slice(0, -SUFFIX.length)
  return local.length > 0 && !local.includes('@')
}
