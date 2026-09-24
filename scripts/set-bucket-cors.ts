/**
 * Allow browsers to fetch HLS and DASH media from SeaweedFS, then prove that they can.
 *
 * Run: npm run set-bucket-cors
 *
 * Progressive MP4 playback never needed CORS, because a `<video src>` element is a no-CORS
 * media load. The adaptive engine fetches manifests and segments over XHR, so every one of
 * them is now a cross-origin request: the app runs on one host and SeaweedFS answers on
 * another. Without the headers below, HLS and DASH fail with a console full of CORS errors
 * and no symptom in the UI beyond a video that will not start — which reads as "the
 * transcoder is broken" and sends you looking in entirely the wrong place.
 *
 * The `PutBucketCors` call is the easy half and not the point. SeaweedFS's S3 gateway can
 * accept a CORS configuration it does not actually serve, so this script applies the
 * policy, reads it back, and then makes two *real* browser-shaped requests against a real
 * object to see whether the header comes back. It exits non-zero when it does not, rather
 * than reporting success for a PUT that changed nothing.
 *
 * If the probe fails, the fixes in order of preference are:
 *   1. Restart the gateway with its own allowed-origins flag (`weed s3 -allowedOrigins='*'`).
 *      An ops change on the SeaweedFS host, and usually the one that works.
 *   2. Point SEAWEED_PUBLIC_URL at the filer port, which handles CORS separately. No code
 *      change at all — this is what that variable is for.
 *   3. Put a reverse proxy in front of SeaweedFS that adds the header.
 *   4. Proxy media through the app so it is same-origin. Last resort: every segment byte
 *      would then flow through Node, which is the load adaptive streaming exists to avoid.
 */
import {
  configuredCorsOrigins,
  deleteObject,
  getBucketCors,
  putBucketCors,
  uploadObject,
} from '../src/server/storage/seaweed.ts'

/** The origin a browser would send. Override when testing the deployed app's own host. */
const origin = process.argv.find((a) => a.startsWith('--origin='))?.slice('--origin='.length)
  || process.env.APP_URL
  || 'http://localhost:3000'

const probeKey = `cors-probe/${Date.now()}.m3u8`

function header(response: Response, name: string): string {
  return response.headers.get(name) ?? ''
}

function report(label: string, value: string): void {
  console.log(`  ${label.padEnd(34)} ${value || '(absent)'}`)
}

async function main() {
  console.log(`Applying CORS for origins: ${configuredCorsOrigins().join(', ')}`)
  console.log(`Probing as a browser on: ${origin}`)
  console.log('')

  await putBucketCors()
  console.log('PutBucketCors accepted.')

  try {
    console.log('Bucket now reports:', JSON.stringify(await getBucketCors()))
  } catch (error) {
    // Not fatal on its own — some gateways serve the headers without implementing the
    // read-back. The probes below are the real verdict.
    console.log('GetBucketCors failed (not fatal, the probes decide):', String(error))
  }

  // A real object, because a gateway can answer differently for a key that does not exist.
  const probeUrl = await uploadObject({
    key: probeKey,
    body: Buffer.from('#EXTM3U\n'),
    contentType: 'application/vnd.apple.mpegurl',
  })
  console.log(`\nProbe object: ${probeUrl}`)

  let ok = true

  try {
    // Exactly the preflight the engine triggers: a cross-origin GET that wants a Range
    // header is not a simple request, so the browser asks permission first.
    console.log('\nPreflight (OPTIONS):')
    const preflight = await fetch(probeUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'range',
      },
    })
    report('status', String(preflight.status))
    report('access-control-allow-origin', header(preflight, 'access-control-allow-origin'))
    report('access-control-allow-methods', header(preflight, 'access-control-allow-methods'))
    report('access-control-allow-headers', header(preflight, 'access-control-allow-headers'))
    if (!header(preflight, 'access-control-allow-origin')) ok = false

    console.log('\nActual fetch (GET with Origin):')
    const get = await fetch(probeUrl, { headers: { Origin: origin } })
    report('status', String(get.status))
    report('content-type', header(get, 'content-type'))
    report('access-control-allow-origin', header(get, 'access-control-allow-origin'))
    report('access-control-expose-headers', header(get, 'access-control-expose-headers'))
    report('accept-ranges', header(get, 'accept-ranges'))
    if (!header(get, 'access-control-allow-origin')) ok = false
  } finally {
    await deleteObject(probeKey).catch(() => {})
  }

  console.log('')
  if (ok) {
    console.log('CORS is being served. HLS and DASH can be fetched from a browser.')
    return
  }

  // Loud and non-zero: a silent success here would send someone debugging the transcoder
  // for a problem that lives entirely in the storage gateway's configuration.
  console.error('CORS headers are NOT being served, despite PutBucketCors succeeding.')
  console.error('Adaptive playback will fail in the browser. See this file for the fixes,')
  console.error("starting with restarting the gateway as: weed s3 -allowedOrigins='*'")
  process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
