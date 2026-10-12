/**
 * Prove that media can no longer be fetched from SeaweedFS without the app's credentials.
 *
 * Run: npm run check:media-private
 *
 * Every url the app hands out is now a signed, expiring `/api/media/...` address, but that
 * only protects anything once the bucket itself stops answering anonymous requests: the
 * stored urls on every video row are still plain SeaweedFS addresses, and anyone who has ever
 * seen one could otherwise keep using it. This checks that from the outside, the same way an
 * attacker would, rather than trusting a config file.
 *
 * Two objects are probed, because they can differ:
 *   - a fresh one, uploaded the way the app uploads now (no `public-read` ACL), and
 *   - an existing one under `videos/`, uploaded before, when every object was `public-read`.
 *     A gateway that honours per-object ACLs can refuse the first and still serve the second.
 *
 * Each must be refused anonymously and still readable with the app's credentials — the second
 * half matters just as much, since a bucket locked against the app too would stop all playback.
 * Exits non-zero while anything is still publicly readable.
 *
 * To lock the bucket on the SeaweedFS host, remove anonymous read from the S3 identity config
 * (`s3.json`, passed as `weed s3 -config=...`): delete the `anonymous` identity, or at least its
 * `Read` / `Read:g-hub-media` action, then restart `weed s3`. Do this only once every branch
 * that still plays media straight from SeaweedFS has been merged past, or it stops playing.
 */
import {
  deleteObject,
  getObjectRange,
  listObjectKeys,
  publicHttpUrl,
  uploadObject,
} from '../src/server/storage/object-store.ts'

type Probe = { label: string; key: string }

async function anonymousStatus(key: string): Promise<number | string> {
  try {
    const response = await fetch(publicHttpUrl(key), { headers: { range: 'bytes=0-0' } })
    await response.body?.cancel()
    return response.status
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function authenticatedReadable(key: string): Promise<boolean> {
  const object = await getObjectRange(key, 'bytes=0-0')
  await object?.body.cancel()
  return object !== null
}

async function main() {
  const probeKey = `private-probe/${Date.now()}.txt`
  await uploadObject({ key: probeKey, body: Buffer.from('probe'), contentType: 'text/plain' })

  const probes: Probe[] = [{ label: 'new upload (no ACL)', key: probeKey }]
  const existing = (await listObjectKeys('videos/')).find((key) => !key.endsWith('/'))
  if (existing) probes.push({ label: 'existing object', key: existing })
  else console.log('No existing object under videos/ to probe; checking the new upload only.')

  let exposed = false
  let locked = false

  try {
    for (const { label, key } of probes) {
      const status = await anonymousStatus(key)
      const refused = status === 401 || status === 403
      const readable = await authenticatedReadable(key)

      console.log(`${label}: ${key}`)
      console.log(`  anonymous GET        ${status}  ${refused ? 'refused, as it should be' : 'SERVED — still public'}`)
      console.log(`  with app credentials ${readable ? 'readable, as it should be' : 'NOT READABLE — playback would break'}`)
      console.log('')

      if (!refused) exposed = true
      if (!readable) locked = true
    }
  } finally {
    await deleteObject(probeKey)
  }

  if (locked) {
    console.log('The app itself cannot read media. Check SEAWEED_S3_ACCESS_KEY / SECRET_KEY and that')
    console.log('identity\'s actions in s3.json before anything else.')
    process.exitCode = 1
  }
  if (exposed) {
    console.log('Media is still publicly readable. Remove anonymous read from s3.json on the SeaweedFS')
    console.log('host and restart `weed s3` (see the header of this script).')
    process.exitCode = 1
  }
  if (!locked && !exposed) console.log('Bucket is private: only the app can read media.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
