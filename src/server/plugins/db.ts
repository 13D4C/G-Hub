import { definePlugin } from 'nitro'
import { connectToDatabase } from '@/server/db/mongoose'

export default definePlugin(() => {
  connectToDatabase().catch(() => {})
})
