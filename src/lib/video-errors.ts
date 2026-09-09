export const VIDEO_ERRORS = {
  invalidFile: 'Please choose a video file.',
  titleRequired: 'Please give it a title.',
} as const

const USER_FACING = new Set<string>(Object.values(VIDEO_ERRORS))

export function isUserFacingVideoError(message: string): boolean {
  return USER_FACING.has(message)
}
