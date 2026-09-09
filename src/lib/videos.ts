import { queryOptions } from '@tanstack/react-query'
import { listMyVideos } from '@/server/functions/videos'

export const myVideosQueryOptions = queryOptions({
  queryKey: ['myVideos'],
  queryFn: () => listMyVideos(),
})
