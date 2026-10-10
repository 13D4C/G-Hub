/**
 * Self-check for the signed media grants behind `/api/media/*`.
 *
 * Run: npm run test:media-token
 *
 * `media-token.ts` imports nothing but `node:crypto` precisely so this can run under plain
 * `node --experimental-strip-types`, with no database, no storage and no `.env`. Same
 * arrangement as `test-video-sources.ts`.
 *
 * Every assertion below is one way somebody could try to read a file they were not handed:
 * forging a grant, stretching one, borrowing someone else's, walking out of the directory one
 * names, or fetching the url some way other than the page's own player.
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  decodePathSegments,
  expiryFor,
  grantShapeFor,
  mediaPathFor,
  mediaRequestAllowed,
  resolveMediaKey,
  signMediaToken,
  verifyMediaToken,
  type MediaGrant,
} from '../src/server/lib/media-token.ts'

const SECRET = 'test-secret-that-is-at-least-32-characters-long'
const NOW = 1_800_000_000
const TREE = 'videos/6a986dd6f5a8502905efecf0/0b5c7e7e-3d1c-4b5e-9d59-1f7b6f1b2c3d/'

const grant: MediaGrant = { scope: TREE, exp: NOW + 3600, userId: 'user-1' }

// --- a genuine grant round-trips -----------------------------------------------------

{
  const token = signMediaToken(grant, SECRET)
  assert.deepEqual(verifyMediaToken(token, SECRET, NOW), grant)
  assert.ok(!token.includes('/'), 'a token is one path segment, never several')
  assert.equal(
    encodeURIComponent(token),
    token,
    'a token needs no escaping, so the url the player resolves is the url that was signed',
  )
}

// --- forged, altered and malformed tokens are refused ---------------------------------

{
  const token = signMediaToken(grant, SECRET)
  const [version, body, signature] = token.split('.')

  assert.equal(verifyMediaToken(token, 'some-other-secret-of-32-characters!!', NOW), null,
    'a token signed with another key is refused')

  // Widen the grant to the whole bucket and keep the old signature.
  const widened = Buffer.from(
    JSON.stringify({ s: 'videos/', e: grant.exp, u: grant.userId }),
  ).toString('base64url')
  assert.equal(verifyMediaToken(`${version}.${widened}.${signature}`, SECRET, NOW), null,
    'an altered payload no longer matches its signature')

  // Extend the expiry and keep the old signature.
  const extended = Buffer.from(
    JSON.stringify({ s: grant.scope, e: grant.exp + 86_400 * 365, u: grant.userId }),
  ).toString('base64url')
  assert.equal(verifyMediaToken(`${version}.${extended}.${signature}`, SECRET, NOW), null,
    'an extended expiry no longer matches its signature')

  // Strip the user binding and keep the old signature.
  const unbound = Buffer.from(
    JSON.stringify({ s: grant.scope, e: grant.exp, u: '' }),
  ).toString('base64url')
  assert.equal(verifyMediaToken(`${version}.${unbound}.${signature}`, SECRET, NOW), null,
    'removing the viewer binding no longer matches its signature')

  const flipped = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A')
  assert.equal(verifyMediaToken(`${version}.${body}.${flipped}`, SECRET, NOW), null,
    'a single changed signature character is refused')

  for (const junk of [
    '',
    'v1',
    'v1..',
    `${version}.${body}`,
    `v2.${body}.${signature}`,
    `${token}.extra`,
    'not-a-token-at-all',
  ]) {
    assert.equal(verifyMediaToken(junk, SECRET, NOW), null, `${JSON.stringify(junk)} is refused`)
  }

  // Correctly signed, but not the payload shape this module writes.
  for (const payload of [
    'null',
    '"a string"',
    JSON.stringify({ s: '', e: NOW + 60, u: '' }),
    JSON.stringify({ s: TREE, e: 'tomorrow', u: '' }),
    JSON.stringify({ s: TREE, e: NOW + 60 }),
  ]) {
    const b = Buffer.from(payload).toString('base64url')
    const sig = createHmac('sha256', SECRET).update(`v1.${b}`).digest('base64url')
    assert.equal(verifyMediaToken(`v1.${b}.${sig}`, SECRET, NOW), null,
      `a signed but malformed payload ${payload} is refused`)
  }
}

// --- expiry ---------------------------------------------------------------------------

{
  const token = signMediaToken(grant, SECRET)
  assert.ok(verifyMediaToken(token, SECRET, grant.exp - 1), 'valid until its last second')
  assert.equal(verifyMediaToken(token, SECRET, grant.exp), null, 'refused at its expiry')
  assert.equal(verifyMediaToken(token, SECRET, grant.exp + 1), null, 'refused after it')
}

{
  // Rounded up to a whole bucket, never down, so a grant is never shorter than asked for.
  const exp = expiryFor(NOW, 7200)
  assert.ok(exp >= NOW + 7200, 'the expiry is at least the ttl away')
  assert.ok(exp < NOW + 7200 + 600, 'and at most one bucket longer')
  assert.equal(exp % 600, 0, 'on a bucket boundary')

  // The same file asked for twice within a bucket yields the same token string, so the
  // player is not handed a "new" url for the same file on every poll.
  const bucketStart = Math.ceil(NOW / 600) * 600
  const a = signMediaToken({ ...grant, exp: expiryFor(bucketStart + 1, 7200) }, SECRET)
  const b = signMediaToken({ ...grant, exp: expiryFor(bucketStart + 599, 7200) }, SECRET)
  assert.equal(a, b, 'two signings in one bucket are identical')
  const c = signMediaToken({ ...grant, exp: expiryFor(bucketStart + 601, 7200) }, SECRET)
  assert.notEqual(a, c, 'the next bucket mints a new one')
}

// --- scope: a directory grant opens its tree and nothing beside it --------------------

{
  assert.equal(resolveMediaKey(TREE, ['master.m3u8']), `${TREE}master.m3u8`)
  assert.equal(resolveMediaKey(TREE, ['chunk-2-00017.m4s']), `${TREE}chunk-2-00017.m4s`)
  assert.equal(resolveMediaKey(TREE, []), null, 'the directory itself is not a file')
}

{
  // An exact-key grant opens only its own object, requested by its own name. The seeded
  // originals sit side by side in flat directories, so this is what stops a grant for one
  // premium video from opening its neighbours.
  const key = 'premium/one.mp4'
  assert.equal(resolveMediaKey(key, ['one.mp4']), key)
  assert.equal(resolveMediaKey(key, ['two.mp4']), null, 'a neighbour is refused')
  assert.equal(resolveMediaKey(key, ['one.mp4', 'more']), null)
  assert.equal(resolveMediaKey(key, []), null)
}

// --- path segments: nothing may step outside the grant --------------------------------

{
  assert.deepEqual(decodePathSegments(['master.m3u8']), ['master.m3u8'])
  assert.deepEqual(decodePathSegments(['my%20video.mp4']), ['my video.mp4'],
    'an escaped name decodes to the stored name')

  for (const [raw, why] of [
    [['..', 'other', 'master.m3u8'], 'a parent step'],
    [['%2E%2E', 'master.m3u8'], 'an encoded parent step'],
    [['.'], 'a current-directory step'],
    [['a%2Fb'], 'an encoded slash hidden inside one segment'],
    [['a%5Cb'], 'an encoded backslash'],
    [['a\\b'], 'a raw backslash'],
    [['a%00b'], 'an encoded NUL'],
    [['', 'master.m3u8'], 'an empty segment from a doubled slash'],
    [['%E0%A4%A'], 'a malformed escape'],
  ] as const) {
    assert.equal(decodePathSegments([...raw]), null, `${why} is refused`)
  }

  // End to end: a directory grant plus a crafted path never resolves outside the tree.
  const crafted = decodePathSegments(['..', '..', 'premium', 'secret.mp4'])
  assert.equal(crafted && resolveMediaKey(TREE, crafted), null)
}

// --- the url shape the proxy expects ---------------------------------------------------

{
  const manifestKey = `${TREE}master.m3u8`
  const dir = grantShapeFor(manifestKey, true)
  assert.deepEqual(dir, { scope: TREE, file: 'master.m3u8' },
    'a manifest is granted its whole directory, so its segments come with it')

  const file = grantShapeFor('videos/abc/uuid/my video.mp4', false)
  assert.deepEqual(file, { scope: 'videos/abc/uuid/my video.mp4', file: 'my video.mp4' })

  const token = signMediaToken({ ...grant, scope: file.scope }, SECRET)
  const path = mediaPathFor(token, file.file)
  assert.equal(path, `/api/media/${token}/my%20video.mp4`)

  // What the proxy does with that path, step for step.
  const [gotToken, ...rest] = path.slice('/api/media/'.length).split('/')
  const verified = verifyMediaToken(gotToken, SECRET, NOW)
  assert.ok(verified)
  const segments = decodePathSegments(rest)
  assert.ok(segments)
  assert.equal(resolveMediaKey(verified.scope, segments), file.scope)

  // And a segment the manifest names relatively resolves under the same token.
  const manifestUrl = new URL(mediaPathFor(signMediaToken(grant, SECRET), 'master.m3u8'),
    'http://localhost:3000')
  const segmentUrl = new URL('chunk-0-00001.m4s', manifestUrl)
  assert.ok(segmentUrl.pathname.startsWith(manifestUrl.pathname.replace(/master\.m3u8$/, '')),
    'a relative segment url keeps the manifest\'s token segment')
}

// --- request metadata: only the page's own player gets through ------------------------

{
  const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null

  // Allowed: the adaptive engine's XHR, and a media element.
  assert.equal(mediaRequestAllowed(headers({
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
  })), true, 'VHS fetching a segment')
  assert.equal(mediaRequestAllowed(headers({
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'video',
  })), true, 'a <video> loading a progressive file')
  assert.equal(mediaRequestAllowed(headers({
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'audio',
  })), true, 'an <audio> element')
  assert.equal(mediaRequestAllowed(headers({})), true,
    'no metadata at all (an older browser) is left to the token')

  // Refused.
  for (const [h, why] of [
    [{ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      'the url pasted into the address bar'],
    [{ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      'an extension fetching from its own background context'],
    [{ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      'another site scraping the stream'],
    [{ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      'a sibling subdomain'],
    [{ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      'opening the file from a link on the page itself'],
    [{ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'empty' },
      'a navigation, whatever it claims to be for'],
    [{ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'iframe' },
      'framing the file'],
    [{ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'embed' },
      'embedding the file'],
  ] as const) {
    assert.equal(mediaRequestAllowed(headers(h)), false, `${why} is refused`)
  }
}

console.log('media token: all checks passed')
