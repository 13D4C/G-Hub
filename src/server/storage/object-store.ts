import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketCorsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { readFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'

const endpoint = process.env.S3_ENDPOINT || process.env.SEAWEED_S3_ENDPOINT

const region =
  process.env.AWS_REGION || process.env.S3_REGION || process.env.SEAWEED_S3_REGION || 'us-east-1'

const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.SEAWEED_S3_ACCESS_KEY
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.SEAWEED_S3_SECRET_KEY

export const MEDIA_BUCKET =
  process.env.S3_BUCKET || process.env.SEAWEED_S3_BUCKET || 'g-hub-media'

let cachedClient: S3Client | null = null

function getClient(): S3Client {
  if (cachedClient) return cachedClient

  if (endpoint && !(accessKeyId && secretAccessKey)) {
    throw new Error(
      'S3_ENDPOINT is set but S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are not (see .env.example).',
    )
  }

  cachedClient = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  })

  return cachedClient
}

export function storedUrl(key: string): string {
  return `s3://${MEDIA_BUCKET}/${key}`
}

export function publicHttpUrl(key: string): string {
  const safeKey = key.split('/').map(encodeURIComponent).join('/')
  if (endpoint) return `${endpoint.replace(/\/+$/, '')}/${MEDIA_BUCKET}/${safeKey}`
  return `https://${MEDIA_BUCKET}.s3.${region}.amazonaws.com/${safeKey}`
}

export function keyFromStoredUrl(url: string): string | null {
  const s3Prefix = `s3://${MEDIA_BUCKET}/`
  if (url.startsWith(s3Prefix)) return url.slice(s3Prefix.length) || null

  const legacy = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(url)
  if (!legacy) return null

  const bucketPrefix = `${MEDIA_BUCKET}/`
  const path = legacy[1]
  if (!path.startsWith(bucketPrefix)) return null

  const key = path
    .slice(bucketPrefix.length)
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/')

  return key || null
}

type UploadInput = {
  key: string
  body: Buffer | Uint8Array
  contentType?: string
}

export async function uploadObject({ key, body, contentType }: UploadInput): Promise<string> {
  await getClient().send(
    new PutObjectCommand({
      Bucket: MEDIA_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  )

  return storedUrl(key)
}

export async function deleteObject(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }))
}

type UploadFileInput = {
  key: string
  filePath: string
  contentType?: string
}

export async function uploadFile({ key, filePath, contentType }: UploadFileInput): Promise<string> {
  return uploadObject({ key, body: await readFile(filePath), contentType })
}

export async function getObjectStream(key: string): Promise<Readable> {
  const result = await getClient().send(
    new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }),
  )

  if (!result.Body) throw new Error(`Storage object has no body: ${key}`)
  return result.Body as Readable
}

export type RangedObject = {
  body: ReadableStream
  status: 200 | 206
  contentLength?: number
  contentRange?: string
  contentType?: string
  etag?: string
  lastModified?: Date
}

export async function getObjectRange(
  key: string,
  range?: string | null,
): Promise<RangedObject | null> {
  try {
    const result = await getClient().send(
      new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: key, Range: range || undefined }),
    )
    if (!result.Body) return null

    return {
      body: result.Body.transformToWebStream(),
      status: result.ContentRange ? 206 : 200,
      contentLength: result.ContentLength,
      contentRange: result.ContentRange,
      contentType: result.ContentType,
      etag: result.ETag,
      lastModified: result.LastModified,
    }
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

export async function headObject(
  key: string,
): Promise<Omit<RangedObject, 'body' | 'status' | 'contentRange'> | null> {
  try {
    const result = await getClient().send(
      new HeadObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }),
    )
    return {
      contentLength: result.ContentLength,
      contentType: result.ContentType,
      etag: result.ETag,
      lastModified: result.LastModified,
    }
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

function isMissing(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404
}

export async function listObjectKeys(prefix: string): Promise<string[]> {
  const client = getClient()
  const keys: string[] = []
  let continuationToken: string | undefined

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: MEDIA_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )

    for (const item of page.Contents ?? []) {
      if (item.Key) keys.push(item.Key)
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuationToken)

  return keys
}

const DELETE_BATCH = 1000

export async function deleteObjects(keys: string[]): Promise<void> {
  if (keys.length === 0) return

  const client = getClient()

  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    const batch = keys.slice(i, i + DELETE_BATCH)

    try {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: MEDIA_BUCKET,
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

export async function deletePrefix(prefix: string): Promise<void> {
  await deleteObjects(await listObjectKeys(prefix))
}

const corsOrigins = (process.env.S3_CORS_ORIGINS || process.env.SEAWEED_CORS_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

export async function putBucketCors(): Promise<void> {
  await getClient().send(
    new PutBucketCorsCommand({
      Bucket: MEDIA_BUCKET,
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

export async function getBucketCors(): Promise<unknown> {
  const result = await getClient().send(new GetBucketCorsCommand({ Bucket: MEDIA_BUCKET }))
  return result.CORSRules
}

export function configuredCorsOrigins(): string[] {
  return [...corsOrigins]
}
