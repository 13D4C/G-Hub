import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb'
import { docClient, isConditionalCheckFailed, TABLES } from './client.ts'
import type { Id, VideoLikeRepo } from '../types.ts'

const TABLE = TABLES.videoLikes
const BATCH = 25

export const videoLikes: VideoLikeRepo = {
  async exists(videoId: Id, userId: Id): Promise<boolean> {
    const out = await docClient().send(
      new GetCommand({ TableName: TABLE, Key: { videoId, userId }, ProjectionExpression: 'videoId' }),
    )
    return out.Item !== undefined
  },

  async remove(videoId: Id, userId: Id): Promise<boolean> {
    const out = await docClient().send(
      new DeleteCommand({ TableName: TABLE, Key: { videoId, userId }, ReturnValues: 'ALL_OLD' }),
    )
    return out.Attributes !== undefined
  },

  async insert(videoId: Id, userId: Id): Promise<boolean> {
    try {
      await docClient().send(
        new PutCommand({
          TableName: TABLE,
          Item: { videoId, userId, createdAt: Date.now() },
          ConditionExpression: 'attribute_not_exists(videoId) AND attribute_not_exists(userId)',
        }),
      )
      return true
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err
      return false
    }
  },

  async removeByVideo(videoId: Id): Promise<void> {
    const client = docClient()
    let startKey: Record<string, unknown> | undefined

    do {
      const page = await client.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'videoId = :v',
          ExpressionAttributeValues: { ':v': videoId },
          ProjectionExpression: 'videoId, userId',
          ExclusiveStartKey: startKey,
        }),
      )

      const items = page.Items ?? []
      for (let i = 0; i < items.length; i += BATCH) {
        await client.send(
          new BatchWriteCommand({
            RequestItems: {
              [TABLE]: items.slice(i, i + BATCH).map((item) => ({
                DeleteRequest: { Key: { videoId: item.videoId, userId: item.userId } },
              })),
            },
          }),
        )
      }

      startKey = page.LastEvaluatedKey
    } while (startKey)
  },

  async countByVideo(): Promise<Map<Id, number>> {
    const client = docClient()
    const counts = new Map<Id, number>()
    let startKey: Record<string, unknown> | undefined

    do {
      const page = await client.send(
        new ScanCommand({
          TableName: TABLE,
          ProjectionExpression: 'videoId',
          ExclusiveStartKey: startKey,
        }),
      )

      for (const item of page.Items ?? []) {
        const id = String(item.videoId)
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }

      startKey = page.LastEvaluatedKey
    } while (startKey)

    return counts
  },
}
