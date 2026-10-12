import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { docClient, TABLES } from './client.ts'
import type { Id, VideoViewRepo, WatchSignal } from '../types.ts'

const TABLE = TABLES.videoViews
export const LAST_WATCHED_INDEX = 'by-last-watched'

const TTL_SECONDS = 60 * 60 * 24 * 90

export const videoViews: VideoViewRepo = {
  async recordWatch(viewerId: Id, videoId: Id, creatorId: Id | null): Promise<void> {
    const now = Date.now()
    await docClient().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { viewerId, videoId },
        UpdateExpression:
          'ADD watchCount :one SET lastWatchedAt = :now, creatorId = :creator, expiresAt = :ttl',
        ExpressionAttributeValues: {
          ':one': 1,
          ':now': now,
          ':creator': creatorId,
          ':ttl': Math.floor(now / 1000) + TTL_SECONDS,
        },
      }),
    )
  },

  async recentByViewer(viewerId: Id, limit: number): Promise<WatchSignal[]> {
    const out = await docClient().send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: LAST_WATCHED_INDEX,
        KeyConditionExpression: 'viewerId = :v',
        ExpressionAttributeValues: { ':v': viewerId },
        ScanIndexForward: false,
        Limit: limit,
      }),
    )

    return (out.Items ?? []).map((item) => ({
      videoId: String(item.videoId),
      creatorId: item.creatorId ? String(item.creatorId) : null,
      watchCount: Number(item.watchCount) || 1,
    }))
  },
}
