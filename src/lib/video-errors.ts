export const VIDEO_ERRORS = {
  invalidFile: 'Please choose a video file.',
  titleRequired: 'Please give it a title.',
  // Bounds live in `src/lib/video-price.ts`; this message spells them out because a
  // creator who has just been rejected needs to know what would be accepted.
  invalidPrice: 'Enter a price between $0.50 and $5,000.',
  // A `buyer` video with no price is a paywall nobody can open, so the two settings
  // are refused together rather than saved into a state that locks the video out of
  // its own checkout.
  priceRequired: 'Pay-per-view videos need a price.',
} as const

const USER_FACING = new Set<string>(Object.values(VIDEO_ERRORS))

export function isUserFacingVideoError(message: string): boolean {
  return USER_FACING.has(message)
}
