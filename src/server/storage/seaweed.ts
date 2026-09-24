import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketCorsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { readFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'

/**
 * SeaweedFS storage client (S3-compatible gateway).
 *
 * SeaweedFS exposes an S3 API via `weed s3`. We talk to it with the AWS S3 SDK
 * using path-style addressing (`{endpoint}/{bucket}/{key}`), because SeaweedFS
 * does not support virtual-hosted-style bucket subdomains.
 *
 * Objects are stored public-read so the browser can play them directly from the
 * SeaweedFS URL (see `publicUrl`). The bucket must allow anonymous GET.
 */

const endpoint = process.env.SEAWEED_S3_ENDPOINT
const region = process.env.SEAWEED_S3_REGION || 'us-east-1'
const accessKeyId = process.env.SEAWEED_S3_ACCESS_KEY
const secretAccessKey = process.env.SEAWEED_S3_SECRET_KEY

export const SEAWEED_BUCKET = process.env.SEAWEED_S3_BUCKET || 'g-hub-media'

// Base URL the browser uses to fetch objects. Defaults to the S3 endpoint, but
// can be overridden (e.g. a reverse proxy / CDN in front of SeaweedFS).
const publicBase = (process.env.SEAWEED_PUBLIC_URL || endpoint || '').replace(/\/+$/, '')

/**
 * Built once and reused. The client holds a connection pool and no per-request state, and
 * a transcode uploads a segment tree that runs to hundreds of objects for a long video —
 * building a fresh client per object would open a fresh pool per object.
 *
 * Still lazy, so an app running without storage configured boots and only the media paths
 * fail, which is how `stripe.ts` treats its own environment.
 */
let cachedClient: S3Client | null = null

function getClient(): S3Client {
  if (cachedClient) return cachedClient

  if (!endpoint) {
    throw new Error('SEAWEED_S3_ENDPOINT is not set. Add it to your .env file (see .env.example).')
  }
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('SEAWEED_S3_ACCESS_KEY / SEAWEED_S3_SECRET_KEY are not set (see .env.example).')
  }

  cachedClient = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  })

  return cachedClient
}

/** Public URL a browser can use to fetch the stored object. */
export function publicUrl(key: string): string {
  const safeKey = key.split('/').map(encodeURIComponent).join('/')
  return `${publicBase}/${SEAWEED_BUCKET}/${safeKey}`
}

type UploadInput = {
  key: string
  body: Buffer | Uint8Array
  contentType?: string
}

/** Upload an object to SeaweedFS and return its public URL. */
export async function uploadObject({ key, body, contentType }: UploadInput): Promise<string> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: SEAWEED_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      ACL: 'public-read',
    }),
  )

  return publicUrl(key)
}

export function keyFromPublicUrl(url: string): string | null {
  const prefix = `${publicBase}/${SEAWEED_BUCKET}/`
  if (!url.startsWith(prefix)) return null
  return url
    .slice(prefix.length)
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/')
}

export async function deleteObject(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: SEAWEED_BUCKET, Key: key }))
}

type UploadFileInput = {
  key: string
  /** A path on the local disk — a manifest or one segment ffmpeg has just written. */
  filePath: string
  contentType?: string
}

/**
 * Upload a file from disk, returning its public URL.
 *
 * Reads the whole file into memory rather than streaming it, deliberately. A streaming
 * `PutObject` needs an explicit `ContentLength` or the SDK refuses with "Cannot determine
 * length of stream", and the only large object this service handles is the original
 * upload, which `createVideo` already buffers. Everything this uploads is a manifest or a
 * segment — single-digit megabytes — so the complexity would buy nothing.
 */
export async function uploadFile({ key, filePath, contentType }: UploadFileInput): Promise<string> {
  return uploadObject({ key, body: await readFile(filePath), contentType })
}

/**
 * Open a stored object for reading.
 *
 * The transcode worker uses this to pull the source down to a temp file before probing it.
 * Handing ffmpeg the public URL instead would work, but an MP4 with its metadata at the end
 * of the file turns the first seek into a storm of range requests, `-ss` for any seek
 * becomes slow, and a read that fails halfway has no retry — a local copy makes all three
 * somebody else's problem.
 */
export async function getObjectStream(key: string): Promise<Readable> {
  const result = await getClient().send(
    new GetObjectCommand({ Bucket: SEAWEED_BUCKET, Key: key }),
  )

  if (!result.Body) throw new Error(`Storage object has no body: ${key}`)
  return result.Body as Readable
}

/**
 * Every key under a prefix.
 *
 * Paginated, which is not an optimisation: `ListObjectsV2` returns at most 1,000 keys per
 * call, and one hour of video is roughly 2,400 segment objects. A version that read only
 * the first page would look correct on every short test clip and silently orphan thousands
 * of objects per delete in production.
 */
export async function listObjectKeys(prefix: string): Promise<string[]> {
  const client = getClient()
  const keys: string[] = []
  let continuationToken: string | undefined

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: SEAWEED_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )

    for (const item of page.Contents ?? []) {
      if (item.Key) keys.push(item.Key)
    }

    // `NextContinuationToken` is only meaningful while the response says it was truncated;
    // trusting the token alone can loop forever against a gateway that always returns one.
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken)

  return keys
}

/** S3 caps one multi-object delete at this many keys. */
const DELETE_BATCH = 1000

/**
 * Delete many objects — a whole rendition tree, typically.
 *
 * Falls back to deleting one at a time if the bulk call fails. SeaweedFS's S3 gateway has
 * historically been uneven about multi-object delete, and the consequence of a silent
 * failure here is an orphaned segment tree that nothing will ever sweep again, so the
 * slower path is worth having: it is only ever reached when the fast one has already
 * refused.
 */
export async function deleteObjects(keys: string[]): Promise<void> {
  if (keys.length === 0) return

  const client = getClient()

  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    const batch = keys.slice(i, i + DELETE_BATCH)

    try {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: SEAWEED_BUCKET,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      )
    } catch (error) {
      console.error(
        `Bulk delete of ${batch.length} objects failed, falling back to one at a time:`,
        error,
      )
      for (const key of batch) {
        await deleteObject(key)
      }
    }
  }
}

/**
 * Delete everything under a prefix — the whole of one video's storage.
 *
 * The counterpart to `keyFromPublicUrl` + `deleteObject`, which answer for a single object
 * and so cannot clean up after a transcode: one video is a source file plus a manifest plus
 * every segment of every rendition.
 */
export async function deletePrefix(prefix: string): Promise<void> {
  await deleteObjects(await listObjectKeys(prefix))
}

/**
 * The origins allowed to fetch media in a browser.
 *
 * `*` by default, and that is a considered answer rather than a lazy one: every object here
 * is stored `public-read` and already fetchable by anyone with the URL and no browser at
 * all, and none of these requests carries credentials — so `*` grants a page nothing that
 * `curl` does not already have. Narrowing it to the app's origin would be a restriction
 * that stops no attacker and breaks `localhost:3000` during development.
 */
const corsOrigins = (process.env.SEAWEED_CORS_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

/**
 * Allow browsers to fetch media cross-origin.
 *
 * Progressive MP4 playback never needed this: a `<video src>` is a no-CORS media load. The
 * adaptive engine fetches manifests and segments over XHR instead, so without these headers
 * every HLS and DASH request fails — visibly in the console, invisibly in the UI, where it
 * looks like the transcode simply did not work.
 *
 * `Content-Range` and `Accept-Ranges` are exposed because seeking reads byte ranges, and a
 * range response whose headers the page cannot read is a seek that cannot be resolved.
 */
export async function putBucketCors(): Promise<void> {
  await getClient().send(
    new PutBucketCorsCommand({
      Bucket: SEAWEED_BUCKET,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: corsOrigins,
            AllowedMethods: ['GET', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: [
              'Content-Length',
              'Content-Range',
              'Content-Type',
              'Accept-Ranges',
              'ETag',
            ],
            MaxAgeSeconds: 3000,
          },
        ],
      },
    }),
  )
}

/** Read back whatever CORS configuration the bucket is actually holding. */
export async function getBucketCors(): Promise<unknown> {
  const result = await getClient().send(new GetBucketCorsCommand({ Bucket: SEAWEED_BUCKET }))
  return result.CORSRules
}

/** The origins this deployment will ask for, so a script can report them before applying. */
export function configuredCorsOrigins(): string[] {
  return [...corsOrigins]
}
