import { EyeOff, Globe, Ticket, Users, type LucideIcon } from 'lucide-react'
import type { VideoVisibility } from '@/lib/video-visibility'

/**
 * One glyph per audience, widest to narrowest.
 *
 * Kept here rather than beside the enum because `src/lib/video-visibility.ts` must
 * stay import-free — the Mongoose model and the `scripts/*.ts` checks load it under
 * plain `node --experimental-strip-types`, and `lucide-react` would break that.
 *
 * One map rather than one per picker: this used to be copied into the upload form and
 * the video table, and written a third time as an inline ternary on the dashboard
 * whose `else` branch silently labelled anything unrecognised as Private. A `Record`
 * keyed on the enum makes a missing state a typecheck failure instead.
 */
export const VISIBILITY_ICONS: Record<VideoVisibility, LucideIcon> = {
  public: Globe,
  subscriber: Users,
  buyer: Ticket,
  private: EyeOff,
}
