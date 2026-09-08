/**
 * Copy `text` to the clipboard, degrading through three tiers:
 *
 *  1. `navigator.clipboard` — only exists in a secure context (https, or localhost).
 *  2. `document.execCommand('copy')` on an offscreen textarea — deprecated, but the
 *     only programmatic copy available on the deployed origin, which is plain HTTP
 *     (see `deploy/docker-compose.yml`, which publishes port 8080 with no TLS). So
 *     for production this is the primary path, not a fallback.
 *  3. `false` — the caller must show the URL for the viewer to copy by hand.
 *
 * The `typeof` guards keep the module import-safe during SSR; it is only ever called
 * from an event handler.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied, or the document was not focused. Fall through to tier 2.
    }
  }

  if (typeof document === 'undefined') return false

  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.top = '-1000px'
  field.style.opacity = '0'
  document.body.appendChild(field)
  field.select()
  field.setSelectionRange(0, text.length)

  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  field.remove()
  return copied
}
