import { randomUUID } from 'node:crypto'
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { docClient, isConditionalCheckFailed, TABLES } from './client.ts'
import type {
  ClaimedVideo,
  Id,
  TranscodeResultFields,
  VideoCreateFields,
  VideoGatePatch,
  VideoRepo,
  VideoRow,
} from '../types.ts'

const TABLE = TABLES.videos
export const CREATOR_INDEX = 'by-creator'
export const RECENCY_INDEX = 'by-recency'
export const TRANSCODE_INDEX = 'by-transcode'
export const TIER_INDEX = 'by-tier'

/**
 * Every video shares one recency partition so the home feed can read them in
 * created order. Correct and cheap at this scale; shard this value if the write
 * rate ever outgrows a single partition.
 */
const FEED_BUCKET = 'all'

const CLAIMABLE = ['pending', 'processing']

type Item = Record<string, any>

function toRow(item: Item): VideoRow {
  return {
    id: String(item.id),
    title: item.title ?? '',
    description: item.description ?? '',
    url: item.url ?? '',
    uploadedBy: item.uploadedBy ? String(item.uploadedBy) : null,
    durationSeconds: Number(item.durationSeconds) || 0,
    visibility: item.visibility ?? 'public',
    requiredTierId: item.requiredTierId ? String(item.requiredTierId) : null,
    priceCents: item.priceCents === null || item.priceCents === undefined
      ? null
      : Number(item.priceCents),
    adsEnabled: item.adsEnabled !== false,
    likeCount: Number(item.likeCount) || 0,
    viewCount: Number(item.viewCount) || 0,
    shareCount: Number(item.shareCount) || 0,
    createdAt: new Date(Number(item.createdAt)),
    transcode: {
      status: item.transcodeStatus ?? 'pending',
      nextAttemptAt: new Date(Number(item.transcodeNextAttemptAt) || 0),
      attempts: Number(item.transcodeAttempts) || 0,
      workerId: item.transcodeWorkerId ?? '',
      prefix: item.transcodePrefix ?? '',
      hlsUrl: item.transcodeHlsUrl ?? '',
      dashUrl: item.transcodeDashUrl ?? '',
      renditions: item.transcodeRenditions ?? [],
      sourceWidth: Number(item.transcodeSourceWidth) || 0,
      sourceHeight: Number(item.transcodeSourceHeight) || 0,
      error: item.transcodeError ?? '',
      startedAt: item.transcodeStartedAt ? new Date(Number(item.transcodeStartedAt)) : null,
      finishedAt: item.transcodeFinishedAt ? new Date(Number(item.transcodeFinishedAt)) : null,
    },
  }
}

function isVisible(row: VideoRow, viewerId: Id | null): boolean {
  if (row.visibility !== 'private') return true
  return viewerId !== null && row.uploadedBy === viewerId
}

async function pageUntil(
  query: (startKey: Record<string, unknown> | undefined) => Promise<{
    Items?: Item[]
    LastEvaluatedKey?: Record<string, unknown>
  }>,
  keep: (row: VideoRow) => boolean,
  limit: number,
): Promise<VideoRow[]> {
  const rows: VideoRow[] = []
  let startKey: Record<string, unknown> | undefined

  do {
    const page = await query(startKey)
    for (const item of page.Items ?? []) {
      const row = toRow(item)
      if (keep(row)) rows.push(row)
      if (rows.length >= limit) return rows
    }
    startKey = page.LastEvaluatedKey
  } while (startKey)

  return rows
}

async function getItem(videoId: Id): Promise<Item | null> {
  const out = await docClient().send(new GetCommand({ TableName: TABLE, Key: { id: videoId } }))
  return out.Item ?? null
}

/**
 * `requiredTierId` is the partition key of the tier index, so it is omitted rather
 * than written as NULL: DynamoDB rejects a key attribute of the wrong type, and an
 * absent one simply keeps the row out of that sparse index — which is what an
 * ungated video wants.
 */
function itemFor(row: VideoRow): Item {
  return {
    id: row.id,
    feedBucket: FEED_BUCKET,
    title: row.title,
    description: row.description,
    url: row.url,
    uploadedBy: row.uploadedBy,
    durationSeconds: row.durationSeconds,
    visibility: row.visibility,
    requiredTierId: row.requiredTierId ?? undefined,
    priceCents: row.priceCents,
    adsEnabled: row.adsEnabled,
    likeCount: row.likeCount,
    viewCount: row.viewCount,
    shareCount: row.shareCount,
    createdAt: row.createdAt.getTime(),
    transcodeStatus: row.transcode.status,
    transcodeNextAttemptAt: row.transcode.nextAttemptAt.getTime(),
    transcodeAttempts: row.transcode.attempts,
    transcodeWorkerId: row.transcode.workerId,
    transcodePrefix: row.transcode.prefix,
    transcodeHlsUrl: row.transcode.hlsUrl,
    transcodeDashUrl: row.transcode.dashUrl,
    transcodeRenditions: row.transcode.renditions,
    transcodeSourceWidth: row.transcode.sourceWidth,
    transcodeSourceHeight: row.transcode.sourceHeight,
    transcodeError: row.transcode.error,
    transcodeStartedAt: row.transcode.startedAt ? row.transcode.startedAt.getTime() : null,
    transcodeFinishedAt: row.transcode.finishedAt ? row.transcode.finishedAt.getTime() : null,
  }
}

export const videos: VideoRepo = {
  async findById(videoId: Id): Promise<VideoRow | null> {
    const item = await getItem(videoId)
    return item ? toRow(item) : null
  },

  async listVisible(viewerId: Id | null, limit: number): Promise<VideoRow[]> {
    const client = docClient()
    return pageUntil(
      (startKey) =>
        client.send(
          new QueryCommand({
            TableName: TABLE,
            IndexName: RECENCY_INDEX,
            KeyConditionExpression: 'feedBucket = :b',
            ExpressionAttributeValues: { ':b': FEED_BUCKET },
            ScanIndexForward: false,
            ExclusiveStartKey: startKey,
          }),
        ),
      (row) => isVisible(row, viewerId),
      limit,
    )
  },

  async listVisibleByCreators(
    viewerId: Id | null,
    creatorIds: readonly Id[],
    limit: number,
  ): Promise<VideoRow[]> {
    if (creatorIds.length === 0) return []
    const client = docClient()
    const perCreator = await Promise.all(
      [...new Set(creatorIds)].map((creatorId) =>
        pageUntil(
          (startKey) =>
            client.send(
              new QueryCommand({
                TableName: TABLE,
                IndexName: CREATOR_INDEX,
                KeyConditionExpression: 'uploadedBy = :c',
                ExpressionAttributeValues: { ':c': creatorId },
                ScanIndexForward: false,
                ExclusiveStartKey: startKey,
              }),
            ),
          (row) => isVisible(row, viewerId),
          limit,
        ),
      ),
    )

    return perCreator
      .flat()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
  },

  async listVisibleSince(viewerId: Id | null, since: Date, limit: number): Promise<VideoRow[]> {
    const client = docClient()
    return pageUntil(
      (startKey) =>
        client.send(
          new QueryCommand({
            TableName: TABLE,
            IndexName: RECENCY_INDEX,
            KeyConditionExpression: 'feedBucket = :b AND createdAt >= :since',
            ExpressionAttributeValues: { ':b': FEED_BUCKET, ':since': since.getTime() },
            ScanIndexForward: false,
            ExclusiveStartKey: startKey,
          }),
        ),
      (row) => isVisible(row, viewerId),
      limit,
    )
  },

  async listByCreator(creatorId: Id, limit: number): Promise<VideoRow[]> {
    const client = docClient()
    return pageUntil(
      (startKey) =>
        client.send(
          new QueryCommand({
            TableName: TABLE,
            IndexName: CREATOR_INDEX,
            KeyConditionExpression: 'uploadedBy = :c',
            ExpressionAttributeValues: { ':c': creatorId },
            ScanIndexForward: false,
            ExclusiveStartKey: startKey,
          }),
        ),
      () => true,
      limit,
    )
  },

  async countByTier(tierIds: readonly Id[]): Promise<Map<Id, number>> {
    if (tierIds.length === 0) return new Map()
    const client = docClient()
    const counts = new Map<Id, number>()

    await Promise.all(
      [...new Set(tierIds)].map(async (tierId) => {
        let total = 0
        let startKey: Record<string, unknown> | undefined
        do {
          const page = await client.send(
            new QueryCommand({
              TableName: TABLE,
              IndexName: TIER_INDEX,
              KeyConditionExpression: 'requiredTierId = :t',
              ExpressionAttributeValues: { ':t': tierId },
              Select: 'COUNT',
              ExclusiveStartKey: startKey,
            }),
          )
          total += page.Count ?? 0
          startKey = page.LastEvaluatedKey
        } while (startKey)
        if (total > 0) counts.set(tierId, total)
      }),
    )

    return counts
  },

  async create(fields: VideoCreateFields): Promise<VideoRow> {
    const row: VideoRow = {
      id: fields.id,
      title: fields.title,
      description: fields.description,
      url: fields.url,
      uploadedBy: fields.uploadedBy,
      durationSeconds: fields.durationSeconds,
      visibility: fields.visibility,
      requiredTierId: fields.requiredTierId,
      priceCents: fields.priceCents,
      adsEnabled: fields.adsEnabled,
      likeCount: 0,
      viewCount: 0,
      shareCount: 0,
      createdAt: new Date(),
      transcode: {
        status: 'pending',
        nextAttemptAt: new Date(),
        attempts: 0,
        workerId: '',
        prefix: '',
        hlsUrl: '',
        dashUrl: '',
        renditions: [],
        sourceWidth: 0,
        sourceHeight: 0,
        error: '',
        startedAt: null,
        finishedAt: null,
      },
    }

    await docClient().send(
      new PutCommand({
        TableName: TABLE,
        Item: itemFor(row),
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    )

    return row
  },

  async updateDetails(
    videoId: Id,
    creatorId: Id,
    fields: { title: string; description: string },
  ): Promise<VideoRow | null> {
    try {
      const out = await docClient().send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { id: videoId },
          UpdateExpression: 'SET title = :t, description = :d',
          ConditionExpression: 'uploadedBy = :c',
          ExpressionAttributeValues: {
            ':t': fields.title,
            ':d': fields.description,
            ':c': creatorId,
          },
          ReturnValues: 'ALL_NEW',
        }),
      )
      return out.Attributes ? toRow(out.Attributes) : null
    } catch (err) {
      if (isConditionalCheckFailed(err)) return null
      throw err
    }
  },

  async updateGate(videoId: Id, creatorId: Id, patch: VideoGatePatch): Promise<VideoRow | null> {
    try {
      const out = await docClient().send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { id: videoId },
          UpdateExpression: patch.requiredTierId
            ? 'SET visibility = :v, priceCents = :p, adsEnabled = :a, requiredTierId = :r'
            : 'SET visibility = :v, priceCents = :p, adsEnabled = :a REMOVE requiredTierId',
          ConditionExpression: 'uploadedBy = :c',
          ExpressionAttributeValues: {
            ':v': patch.visibility,
            ':p': patch.priceCents,
            ':a': patch.adsEnabled,
            ':c': creatorId,
            ...(patch.requiredTierId ? { ':r': patch.requiredTierId } : {}),
          },
          ReturnValues: 'ALL_NEW',
        }),
      )
      return out.Attributes ? toRow(out.Attributes) : null
    } catch (err) {
      if (isConditionalCheckFailed(err)) return null
      throw err
    }
  },

  async deleteOwned(videoId: Id, creatorId: Id): Promise<VideoRow | null> {
    try {
      const out = await docClient().send(
        new DeleteCommand({
          TableName: TABLE,
          Key: { id: videoId },
          ConditionExpression: 'uploadedBy = :c',
          ExpressionAttributeValues: { ':c': creatorId },
          ReturnValues: 'ALL_OLD',
        }),
      )
      return out.Attributes ? toRow(out.Attributes) : null
    } catch (err) {
      if (isConditionalCheckFailed(err)) return null
      throw err
    }
  },

  async incrementView(videoId: Id): Promise<void> {
    await docClient().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { id: videoId },
        UpdateExpression: 'ADD viewCount :one',
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeValues: { ':one': 1 },
      }),
    )
  },

  async incrementLike(videoId: Id, delta: number): Promise<number> {
    const out = await docClient().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { id: videoId },
        UpdateExpression: 'ADD likeCount :d',
        ExpressionAttributeValues: { ':d': delta },
        ReturnValues: 'ALL_NEW',
      }),
    )
    return Number(out.Attributes?.likeCount) || 0
  },

  async incrementShare(videoId: Id): Promise<number> {
    const out = await docClient().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { id: videoId },
        UpdateExpression: 'ADD shareCount :one',
        ExpressionAttributeValues: { ':one': 1 },
        ReturnValues: 'ALL_NEW',
      }),
    )
    return Number(out.Attributes?.shareCount) || 0
  },

  /**
   * DynamoDB has no "find one matching and update it atomically, oldest first".
   * The claim is therefore optimistic: read the due candidates in order, then try to
   * take each with a condition that still holds only if nobody else got there first.
   */
  async claimNext(
    workerId: string,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<ClaimedVideo | null> {
    const client = docClient()
    const now = Date.now()

    const pools = await Promise.all(
      CLAIMABLE.map((status) =>
        client.send(
          new QueryCommand({
            TableName: TABLE,
            IndexName: TRANSCODE_INDEX,
            KeyConditionExpression: 'transcodeStatus = :s AND transcodeNextAttemptAt <= :now',
            ExpressionAttributeValues: { ':s': status, ':now': now },
            ScanIndexForward: true,
            Limit: 25,
          }),
        ),
      ),
    )

    const candidates = pools
      .flatMap((page) => page.Items ?? [])
      .map(toRow)
      .filter((row) => row.transcode.attempts < maxAttempts)
      .sort((a, b) => a.transcode.nextAttemptAt.getTime() - b.transcode.nextAttemptAt.getTime())

    for (const candidate of candidates) {
      const prefix = randomUUID()
      try {
        const out = await client.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { id: candidate.id },
            UpdateExpression:
              'SET transcodeStatus = :processing, transcodeNextAttemptAt = :lease,' +
              ' transcodeWorkerId = :worker, transcodePrefix = :prefix,' +
              ' transcodeStartedAt = :now, transcodeError = :empty' +
              ' ADD transcodeAttempts :one',
            ConditionExpression:
              'transcodeStatus = :expectedStatus AND transcodeNextAttemptAt = :expectedAt' +
              ' AND transcodeAttempts < :max',
            ExpressionAttributeValues: {
              ':processing': 'processing',
              ':lease': now + leaseMs,
              ':worker': workerId,
              ':prefix': prefix,
              ':now': now,
              ':empty': '',
              ':one': 1,
              ':expectedStatus': candidate.transcode.status,
              ':expectedAt': candidate.transcode.nextAttemptAt.getTime(),
              ':max': maxAttempts,
            },
            ReturnValues: 'ALL_NEW',
          }),
        )

        return {
          id: candidate.id,
          url: candidate.url,
          prefix,
          attempts: Number(out.Attributes?.transcodeAttempts) || 1,
        }
      } catch (err) {
        if (isConditionalCheckFailed(err)) continue
        throw err
      }
    }

    return null
  },

  async renewClaim(videoId: Id, workerId: string, leaseMs: number): Promise<boolean> {
    try {
      await docClient().send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { id: videoId },
          UpdateExpression: 'SET transcodeNextAttemptAt = :lease',
          ConditionExpression:
            'transcodeWorkerId = :worker AND transcodeStatus = :processing',
          ExpressionAttributeValues: {
            ':lease': Date.now() + leaseMs,
            ':worker': workerId,
            ':processing': 'processing',
          },
        }),
      )
      return true
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false
      throw err
    }
  },

  async completeTranscode(
    videoId: Id,
    workerId: string,
    result: TranscodeResultFields,
  ): Promise<boolean> {
    const values: Record<string, unknown> = {
      ':ready': 'ready',
      ':hls': result.hlsUrl,
      ':dash': result.dashUrl,
      ':renditions': result.renditions,
      ':width': result.sourceWidth,
      ':height': result.sourceHeight,
      ':finished': Date.now(),
      ':empty': '',
      ':worker': workerId,
    }
    let expression =
      'SET transcodeStatus = :ready, transcodeHlsUrl = :hls, transcodeDashUrl = :dash,' +
      ' transcodeRenditions = :renditions, transcodeSourceWidth = :width,' +
      ' transcodeSourceHeight = :height, transcodeFinishedAt = :finished,' +
      ' transcodeError = :empty'

    if (result.durationSeconds > 0) {
      expression += ', durationSeconds = :duration'
      values[':duration'] = result.durationSeconds
    }

    try {
      await docClient().send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { id: videoId },
          UpdateExpression: expression,
          ConditionExpression: 'transcodeWorkerId = :worker',
          ExpressionAttributeValues: values,
        }),
      )
      return true
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false
      throw err
    }
  },

  async failTranscode(
    videoId: Id,
    workerId: string,
    giveUp: boolean,
    nextAttemptAt: Date,
    message: string,
  ): Promise<boolean> {
    try {
      await docClient().send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { id: videoId },
          UpdateExpression:
            'SET transcodeStatus = :status, transcodeNextAttemptAt = :next,' +
            ' transcodeError = :error, transcodeFinishedAt = :finished',
          ConditionExpression: 'transcodeWorkerId = :worker',
          ExpressionAttributeValues: {
            ':status': giveUp ? 'failed' : 'pending',
            ':next': nextAttemptAt.getTime(),
            ':error': message,
            ':finished': giveUp ? Date.now() : null,
            ':worker': workerId,
          },
        }),
      )
      return true
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false
      throw err
    }
  },

  async skipTranscode(videoId: Id, workerId: string, reason: string): Promise<boolean> {
    try {
      await docClient().send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { id: videoId },
          UpdateExpression:
            'SET transcodeStatus = :skipped, transcodeError = :error,' +
            ' transcodeFinishedAt = :finished',
          ConditionExpression: 'transcodeWorkerId = :worker',
          ExpressionAttributeValues: {
            ':skipped': 'skipped',
            ':error': reason,
            ':finished': Date.now(),
            ':worker': workerId,
          },
        }),
      )
      return true
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false
      throw err
    }
  },
}
