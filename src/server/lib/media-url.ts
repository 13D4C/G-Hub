import { createHmac } from 'node:crypto'
import { keyFromStoredUrl } from '@/server/storage/object-store'
import { secondsSetting } from '@/server/lib/transcode-plan'
import {
  expiryFor,
  grantShapeFor,
  mediaPathFor,
  signMediaToken,
  verifyMediaToken,
  type MediaGrant,
} from '@/server/lib/media-token'

/**
 * Turning a stored media url into one the browser may use, and back.
 */

/** How long a playback url lives by default. Stretched for long videos; see `signMediaUrl`. */
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000
/** Never shorter than this, so a typo cannot make every url expire before it is used. */
const MIN_TTL_MS = 60 * 1000

export function mediaUrlTtlSeconds(): number {
  return Math.round(
    secondsSetting(process.env.MEDIA_URL_TTL_SECONDS, DEFAULT_TTL_MS, MIN_TTL_MS) / 1000,
  )
}

let cachedSecret: string | null = null

/**
 * The HMAC key for media grants.
 *
 * `MEDIA_SIGNING_SECRET` when set. Otherwise one derived from `SESSION_SECRET`, so an existing
 * `.env` keeps working without a new required variable; the derivation keeps the two keys
 * distinct, so nothing signed for one can be replayed as the other.
 */
function signingSecret(): string {
  if (cachedSecret) return cachedSecret

  const explicit = process.env.MEDIA_SIGNING_SECRET
  if (explicit) {
    if (explicit.length < 32) {
      throw new Error('MEDIA_SIGNING_SECRET is shorter than 32 chars (see .env.example).')
    }
    cachedSecret = explicit
    return explicit
  }

  const session = process.env.SESSION_SECRET
  if (!session || session.length < 32) {
    throw new Error(
      'Neither MEDIA_SIGNING_SECRET nor a SESSION_SECRET of 32+ chars is set (see .env.example).',
    )
  }
  cachedSecret = createHmac('sha256', session).update('g-hub media signing v1').digest('base64url')
  return cachedSecret
}

type SignOptions = {
  /** The viewer, whose session the proxy will insist on; null for an anonymous viewer. */
  viewerId: string | null
  /** True for a manifest: the grant then covers the segments beside it. */
  directory?: boolean
  /** Overrides the configured lifetime, in seconds. */
  ttlSeconds?: number
  /**
   * The video's length. A grant is made to outlast one watch of it with room for pauses, so
   * a viewer is never cut off halfway through a long video by the clock alone.
   */
  durationSeconds?: number
}

/**
 * A signed proxy url for a stored media url, or empty for an empty or foreign one.
 *
 * Empty rather than the input when the url is not one of ours: passing it through would hand
 * out exactly the unsigned address this exists to stop handing out.
 */
export function signMediaUrl(storedUrl: string | null | undefined, options: SignOptions): string {
  if (!storedUrl) return ''
  const key = keyFromStoredUrl(storedUrl)
  if (!key) return ''

  const ttl = Math.max(
    options.ttlSeconds ?? mediaUrlTtlSeconds(),
    options.durationSeconds ? Math.ceil(options.durationSeconds * 2 + 600) : 0,
  )
  const { scope, file } = grantShapeFor(key, options.directory ?? false)
  const token = signMediaToken(
    {
      scope,
      exp: expiryFor(Math.floor(Date.now() / 1000), ttl),
      userId: options.viewerId ?? '',
    },
    signingSecret(),
  )
  return mediaPathFor(token, file)
}

/** How long a catalogue card's preview url lives. It only ever loads one frame of metadata. */
const THUMBNAIL_TTL_SECONDS = 30 * 60

/**
 * A signed url for a catalogue card's preview frame: exact-key, bound to the viewer, and
 * short-lived, since the card reads its metadata once on mount and never plays it.
 */
export function signThumbnailUrl(
  storedUrl: string | null | undefined,
  viewerId: string | null,
): string {
  return signMediaUrl(storedUrl, { viewerId, ttlSeconds: THUMBNAIL_TTL_SECONDS })
}

/** The grant a request's token carries, or null. */
export function readMediaGrant(token: string): MediaGrant | null {
  return verifyMediaToken(token, signingSecret(), Math.floor(Date.now() / 1000))
}
