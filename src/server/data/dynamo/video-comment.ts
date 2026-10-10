import {
  BatchWriteCommand,
  DeleteCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { docClient, isConditionalCheckFailed, TABLES } from './client.ts'
import { newObjectId } from '../object-id.ts'
import type { CommentRow, Id, VideoCommentRepo } from '../types.ts'

const TABLE = TABLES.videoComments
export const VIDEO_INDEX = 'by-video'
const BATCH = 25

type Item = Record<string, unknown>

function toRow(item: Item): CommentRow {
  return {
    id: String(item.id),
    videoId: String(item.videoId),
    userId: String(item.userId),
    body: String(item.body ?? ''),
    createdAt: new Date(Number(item.createdAt)),
    editedAt: item.editedAt ? new Date(Number(item.editedAt)) : null,
  }
}

export const videoComments: VideoCommentRepo = {
  async countByVideo(videoId: Id): Promise<number> {
    const client = docClient()
    let total = 0
    let startKey: Record<string, unknown> | undefined

    do {
      const page = await client.send(
        new QueryCommand({
          TableName: TABLE,
          IndexName: VIDEO_INDEX,
          KeyConditionExpression: 'videoId = :v',
          ExpressionAttributeValues: { ':v': videoId },
          Select: 'COUNT',
          ExclusiveStartKey: startKey,
        }),
      )
      total += page.Count ?? 0
      startKey = page.LastEvaluatedKey
    } while (startKey)

    return total
  },

  async listByVideo(videoId: Id, limit: number, cursor: Id | null): Promise<CommentRow[]> {
    const out = await docClient().send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: VIDEO_INDEX,
        KeyConditionExpression: cursor ? 'videoId = :v AND id < :cursor' : 'videoId = :v',
        ExpressionAttributeValues: cursor ? { ':v': videoId, ':cursor': cursor } : { ':v': videoId },
        ScanIndexForward: false,
        Limit: limit,
      }),
    )
    return (out.Items ?? []).map(toRow)
  },

  async create(videoId: Id, userId: Id, body: string): Promise<CommentRow> {
    const item = {
      id: newObjectId(),
      videoId,
      userId,
      body,
      createdAt: Date.now(),
      editedAt: null,
    }
    await docClient().send(new PutCommand({ TableName: TABLE, Item: item }))
    return toRow(item)
  },

  async updateOwn(
    commentId: Id,
    userId: Id,
    body: string,
    editedAt: Date,
  ): Promise<CommentRow | null> {
    try {
      const out = await docClient().send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { id: commentId },
          UpdateExpression: 'SET body = :b, editedAt = :e',
          ConditionExpression: 'userId = :u',
          ExpressionAttributeValues: { ':b': body, ':e': editedAt.getTime(), ':u': userId },
          ReturnValues: 'ALL_NEW',
        }),
      )
      return out.Attributes ? toRow(out.Attributes) : null
    } catch (err) {
      if (isConditionalCheckFailed(err)) return null
      throw err
    }
  },

  async deleteOwn(commentId: Id, userId: Id): Promise<CommentRow | null> {
    try {
      const out = await docClient().send(
        new DeleteCommand({
          TableName: TABLE,
          Key: { id: commentId },
          ConditionExpression: 'userId = :u',
          ExpressionAttributeValues: { ':u': userId },
          ReturnValues: 'ALL_OLD',
        }),
      )
      return out.Attributes ? toRow(out.Attributes) : null
    } catch (err) {
      if (isConditionalCheckFailed(err)) return null
      throw err
    }
  },

  async deleteByVideo(videoId: Id): Promise<void> {
    const client = docClient()
    let startKey: Record<string, unknown> | undefined

    do {
      const page = await client.send(
        new QueryCommand({
          TableName: TABLE,
          IndexName: VIDEO_INDEX,
          KeyConditionExpression: 'videoId = :v',
          ExpressionAttributeValues: { ':v': videoId },
          ProjectionExpression: 'id',
          ExclusiveStartKey: startKey,
        }),
      )

      const items = page.Items ?? []
      for (let i = 0; i < items.length; i += BATCH) {
        await client.send(
          new BatchWriteCommand({
            RequestItems: {
              [TABLE]: items
                .slice(i, i + BATCH)
                .map((item) => ({ DeleteRequest: { Key: { id: item.id } } })),
            },
          }),
        )
      }

      startKey = page.LastEvaluatedKey
    } while (startKey)
  },
}
