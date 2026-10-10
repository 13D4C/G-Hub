import { definePlugin } from 'nitro'
import { connectToDatabase } from '@/server/db/mongoose'

export default definePlugin(() => {
  if (process.env.DATA_BACKEND === 'dynamo') return

  connectToDatabase().catch(() => {})
})
