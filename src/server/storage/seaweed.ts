import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

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

function getClient(): S3Client {
  if (!endpoint) {
    throw new Error('SEAWEED_S3_ENDPOINT is not set. Add it to your .env file (see .env.example).')
  }
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('SEAWEED_S3_ACCESS_KEY / SEAWEED_S3_SECRET_KEY are not set (see .env.example).')
  }

  return new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  })
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
