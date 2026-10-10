import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Signed, expiring grants to read media through `/api/media/*`.
 *
 * Imports nothing but `node:crypto`, on purpose: `scripts/test-media-token.ts` loads this under
 * plain `node --experimental-strip-types`, which resolves neither the `@/` alias nor
 * extensionless specifiers. Everything that reads the environment or the storage layout lives
 * in `media-url.ts` instead, and hands this module plain values.
 *
 * A grant is carried as a **path segment**, not a query string:
 *
 *   /api/media/<token>/master.m3u8
 *   /api/media/<token>/chunk-2-00017.m4s
 *
 * That is the whole reason signing needs no manifest rewriting. The HLS playlists and the DASH
 * manifest ffmpeg writes name their segments relatively, and a relative url resolves against
 * the manifest's own *path* — it keeps the token segment and drops any query. One token on the
 * manifest therefore signs every segment beneath it, including DASH's `SegmentTemplate`, which
 * could never be presigned one segment at a time.
 */

export type MediaGrant = {
  /**
   * What the grant opens. Either a directory prefix ending in `/` — one transcode's segment
   * tree, `videos/{id}/{prefix}/` — or one exact object key, for a progressive file.
   *
   * The distinction is load-bearing: the seeded originals sit side by side in flat
   * directories (`premium/a.mp4`, `premium/b.mp4`), so a directory grant for one of them
   * would open all of them.
   */
  scope: string
  /** Unix seconds after which the grant is refused. */
  exp: number
  /** The viewer the grant was issued to, or empty for one any holder may use (an ad). */
  userId: string
}

const VERSION = 'v1'

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(`${VERSION}.${body}`).digest('base64url')
}

export function signMediaToken(grant: MediaGrant, secret: string): string {
  const body = Buffer.from(
    JSON.stringify({ s: grant.scope, e: grant.exp, u: grant.userId }),
    'utf8',
  ).toString('base64url')
  return `${VERSION}.${body}.${sign(body, secret)}`
}

/**
 * The grant a token carries, or null for anything forged, altered, malformed or expired.
 *
 * The signature is checked before the payload is even parsed, so nothing an attacker wrote
 * reaches `JSON.parse` unauthenticated.
 */
export function verifyMediaToken(token: string, secret: string, nowSec: number): MediaGrant | null {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION) return null
  const [, body, signature] = parts

  const expected = Buffer.from(sign(body, secret), 'utf8')
  const given = Buffer.from(signature, 'utf8')
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null

  const { s, e, u } = payload as Record<string, unknown>
  if (typeof s !== 'string' || !s || typeof e !== 'number' || typeof u !== 'string') return null
  if (!Number.isFinite(e) || e <= nowSec) return null

  return { scope: s, exp: e, userId: u }
}

/**
 * The segments of a request path, decoded, or null when any of them could step outside the
 * directory a grant names.
 *
 * Decoded one segment at a time, so an encoded slash (`%2F`) arrives *inside* a segment and is
 * refused here rather than silently becoming a path separator after the check has passed.
 */
export function decodePathSegments(rawSegments: string[]): string[] | null {
  const out: string[] = []
  for (const raw of rawSegments) {
    let segment: string
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes('\0')
    ) {
      return null
    }
    out.push(segment)
  }
  return out
}

/**
 * The storage key a request under a grant resolves to, or null when it is outside the grant.
 *
 * A directory grant opens anything beneath it. An exact-key grant opens only that object,
 * requested by its own file name — the url shape `mediaPathFor` produces for it.
 */
export function resolveMediaKey(scope: string, segments: string[]): string | null {
  if (segments.length === 0) return null

  if (scope.endsWith('/')) return scope + segments.join('/')

  const name = scope.slice(scope.lastIndexOf('/') + 1)
  return segments.length === 1 && segments[0] === name ? scope : null
}

/**
 * The scope and file name to sign for one stored object.
 *
 * `directory: true` is for a manifest, whose playlists and segments live beside it, so the
 * grant must cover the manifest's whole directory. Everything else gets an exact-key grant.
 */
export function grantShapeFor(key: string, directory: boolean): { scope: string; file: string } {
  const slash = key.lastIndexOf('/')
  const file = key.slice(slash + 1)
  return { scope: directory ? key.slice(0, slash + 1) : key, file }
}

/** The proxy url for a signed grant and the file requested under it. */
export function mediaPathFor(token: string, file: string): string {
  return `/api/media/${token}/${encodeURIComponent(file)}`
}

/**
 * The expiry to sign: at least `ttlSec` from now, rounded up to a whole `bucketSec`.
 *
 * Rounded so that asking twice within one bucket yields the *same token string*. The watch
 * page receives these urls from a loader and a poll; a token minted fresh on every call would
 * hand React a new string each time for the same file.
 */
export function expiryFor(nowSec: number, ttlSec: number, bucketSec = 600): number {
  return Math.ceil((nowSec + ttlSec) / bucketSec) * bucketSec
}

/**
 * Whether a request looks like the page's own player fetching media, going by the browser's
 * `Sec-Fetch-*` metadata. This is the check that turns away the easy ways of lifting a file:
 *
 * - `Sec-Fetch-Site: none` is a request no page made: a url pasted into the address bar, a
 *   bookmark, or a downloader extension fetching from its own background context.
 * - `cross-site` / `same-site` is another origin hot-linking or scraping the stream.
 * - `Sec-Fetch-Mode: navigate` / a `document`-like destination is the file being opened as a
 *   page, or saved through the browser's download path.
 *
 * What passes is same-origin `empty` (the adaptive engine's XHR) and `video`/`audio` (a media
 * element). A request with no metadata at all is allowed: older browsers do not send it, and a
 * non-browser client can forge any header it likes, so refusing it would break real viewers and
 * stop nobody — that client still needs a valid, unexpired, user-bound token.
 */
export function mediaRequestAllowed(header: (name: string) => string | null): boolean {
  const site = header('sec-fetch-site')
  if (site !== null && site !== 'same-origin') return false

  const mode = header('sec-fetch-mode')
  if (mode === 'navigate' || mode === 'nested-navigate') return false

  const dest = header('sec-fetch-dest')
  if (dest !== null && dest !== 'empty' && dest !== 'video' && dest !== 'audio') return false

  return true
}
