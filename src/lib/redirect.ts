/**
 * Narrows a caller-supplied `?redirect=` value to a same-origin path so it can
 * never be used to bounce a signed-in user to another site.
 */
export function safeInternalPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}
