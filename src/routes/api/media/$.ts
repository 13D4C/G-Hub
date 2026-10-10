import { createFileRoute } from '@tanstack/react-router'
import { getUserId } from '@/server/auth/require-user'
import { decodePathSegments, mediaRequestAllowed, resolveMediaKey } from '@/server/lib/media-token'
import { readMediaGrant } from '@/server/lib/media-url'
import { contentTypeFor } from '@/server/lib/transcode-plan'
import { getObjectRange, headObject } from '@/server/storage/seaweed'

/**
 * Every media byte a browser receives: `/api/media/<token>/<file>`.
 *
 * The bucket behind this is meant to be private, which makes this the only way in. A request
 * is let through only when all of these hold:
 *
 * 1. The token is one this server signed, unaltered and unexpired (`readMediaGrant`).
 * 2. The file asked for lies inside what the token grants (`resolveMediaKey`).
 * 3. The token was issued to the session making the request, when it was issued to anyone.
 *    The session cookie rides along on the player's same-origin requests, so a url copied
 *    into another browser, or shared, is refused there.
 * 4. The request looks like this page's player rather than a download (`mediaRequestAllowed`).
 *
 * Every refusal is the same bare 403, so a probe learns nothing about which check it failed.
 *
 * Entitlement is not re-checked per request. It was checked when the url was issued, by the
 * same `requirePlayableVideo` gate as always. A segment arrives every few seconds per viewer,
 * and the token's expiry is what bounds how long a revoked subscription keeps playing.
 */

const PREFIX = '/api/media/'

function forbidden(): Response {
  return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'no-store' } })
}

function isManifest(key: string): boolean {
  return key.endsWith('.m3u8') || key.endsWith('.mpd')
}

type Authorised = { key: string; exp: number }

async function authorise(request: Request): Promise<Authorised | null> {
  if (!mediaRequestAllowed((name) => request.headers.get(name))) return null

  // Read after the URL parser has normalised it: `..` already removed, `\` already read as
  // `/`. Normalising only ever shortens a path, and the token must still be its first segment,
  // so no spelling of a path can resolve outside the directory the token grants.
  const path = new URL(request.url).pathname
  if (!path.startsWith(PREFIX)) return null
  const [token, ...rest] = path.slice(PREFIX.length).split('/')
  if (!token) return null

  const grant = readMediaGrant(token)
  if (!grant) return null

  const segments = decodePathSegments(rest)
  const key = segments ? resolveMediaKey(grant.scope, segments) : null
  if (!key) return null

  if (grant.userId && grant.userId !== (await getUserId())) return null

  return { key, exp: grant.exp }
}

/** Headers every successful media response carries. */
function baseHeaders(key: string, exp: number, contentType?: string): Headers {
  const remaining = Math.max(0, exp - Math.floor(Date.now() / 1000))
  return new Headers({
    'content-type': contentType || contentTypeFor(key),
    'accept-ranges': 'bytes',
    // A manifest is re-read on every load so it never outlives the grant that fetched it;
    // a segment is immutable, and may be kept by this browser alone for as long as the
    // grant would have let it be fetched again anyway.
    'cache-control': isManifest(key)
      ? 'no-store'
      : `private, max-age=${Math.min(remaining, 3600)}`,
    'content-disposition': 'inline',
    'x-content-type-options': 'nosniff',
    // No other site may embed or read these, even with a valid url in hand.
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'same-origin',
  })
}

export const Route = createFileRoute('/api/media/$')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authorised = await authorise(request)
        if (!authorised) return forbidden()
        const { key, exp } = authorised

        let object
        try {
          object = await getObjectRange(key, request.headers.get('range'))
        } catch (error) {
          if ((error as { name?: string } | null)?.name === 'InvalidRange') {
            return new Response(null, { status: 416 })
          }
          throw error
        }
        if (!object) return new Response('Not found', { status: 404 })

        const headers = baseHeaders(key, exp, object.contentType)
        if (object.contentLength !== undefined) {
          headers.set('content-length', String(object.contentLength))
        }
        if (object.contentRange) headers.set('content-range', object.contentRange)
        if (object.etag) headers.set('etag', object.etag)
        if (object.lastModified) headers.set('last-modified', object.lastModified.toUTCString())

        return new Response(object.body, { status: object.status, headers })
      },

      HEAD: async ({ request }) => {
        const authorised = await authorise(request)
        if (!authorised) return forbidden()
        const { key, exp } = authorised

        const object = await headObject(key)
        if (!object) return new Response(null, { status: 404 })

        const headers = baseHeaders(key, exp, object.contentType)
        if (object.contentLength !== undefined) {
          headers.set('content-length', String(object.contentLength))
        }
        if (object.etag) headers.set('etag', object.etag)
        return new Response(null, { status: 200, headers })
      },
    },
  },
})
