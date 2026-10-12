import { PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'
import { docClient, TABLES } from './client.ts'
import { newObjectId } from '../object-id.ts'
import type { AdRepo, AdRow, AdSeedFields } from '../types.ts'

const TABLE = TABLES.ads
export const ACTIVE_INDEX = 'by-active'

export const ads: AdRepo = {
  async listActive(): Promise<AdRow[]> {
    const out = await docClient().send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: ACTIVE_INDEX,
        KeyConditionExpression: 'active = :a',
        ExpressionAttributeValues: { ':a': '1' },
      }),
    )

    return (out.Items ?? []).map((item) => ({
      id: String(item.id),
      title: String(item.title ?? ''),
      mediaUrl: String(item.mediaUrl ?? ''),
      durationSeconds: Number(item.durationSeconds) || 0,
      clickThroughUrl: String(item.clickThroughUrl ?? ''),
      skippableAfterSeconds: Number(item.skippableAfterSeconds) || 0,
      weight: Number(item.weight) || 0,
    }))
  },

  async upsertByTitle(title: string, fields: AdSeedFields): Promise<void> {
    const client = docClient()
    let existingId: string | null = null
    let startKey: Record<string, unknown> | undefined

    do {
      const page = await client.send(
        new ScanCommand({ TableName: TABLE, ExclusiveStartKey: startKey }),
      )
      for (const item of page.Items ?? []) {
        if (item.title === title) existingId = String(item.id)
      }
      startKey = page.LastEvaluatedKey
    } while (startKey && !existingId)

    await client.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          id: existingId ?? newObjectId(),
          title,
          mediaUrl: fields.mediaUrl,
          durationSeconds: 0,
          clickThroughUrl: '',
          skippableAfterSeconds: fields.skippableAfterSeconds,
          weight: fields.weight,
          active: fields.active ? '1' : '0',
        },
      }),
    )
  },
}
