import { definePlugin } from 'nitro'
import { startTranscodeWorker } from '@/server/lib/transcode-worker'

/**
 * Run the transcode worker inside the app process.
 *
 * On by default, so an upload turns into HLS and DASH with nothing else running — which is
 * what makes "uploading triggers a transcode" true of a plain `npm run dev` and of the
 * single-container deployment, neither of which has anywhere else to put a worker.
 * `TRANSCODE_INLINE=0` turns it off wherever the web process should not be competing with
 * ffmpeg for CPU; `npm run transcode-worker` then does the work instead.
 *
 * Costs nothing when ffmpeg is absent: the worker checks once, says so, and never polls. The
 * development machines this is written on have no ffmpeg, and `npm run dev` has to stay
 * usable for everyone not working on video.
 *
 * Deliberately registers no signal handler. Adding a SIGTERM listener in Node replaces the
 * default terminate behaviour, so a plugin that installed one to shut down tidily would stop
 * the container exiting at all. Being killed mid-encode is already a path this handles: the
 * lease expires and the next worker re-claims the video, which is the same recovery a crash
 * takes and therefore the one actually exercised.
 */
export default definePlugin(() => {
  if (process.env.TRANSCODE_INLINE === '0') return

  startTranscodeWorker()
})
