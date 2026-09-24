/**
 * Encode queued videos into HLS and DASH.
 *
 * Run:
 *   npm run transcode-worker           # poll forever
 *   npm run transcode-worker:once      # drain what is queued now, then exit
 *
 * In PowerShell, quote the separator: `npm run <script> '--' --flag`. PowerShell's `npm.ps1`
 * shim consumes a bare `--` as its own end-of-parameters marker, so npm never sees it and the
 * flag vanishes without an error — which for this script means a dry run that looks like it
 * worked. The `:apply` / `:once` scripts exist so the common cases need no quoting at all.
 *
 * The app already runs this same loop in-process unless `TRANSCODE_INLINE=0`, so this script
 * is not normally required. It exists for the two cases the embedded loop is bad at: draining
 * a backlog after a backfill without loading the box that serves the site, and running a
 * worker somewhere you can watch its output.
 *
 * Safe to run alongside the app and alongside other copies of itself. Claiming is one atomic
 * document update, so two workers cannot take the same video — an extra worker is extra
 * throughput, not a race.
 *
 * Needs ffmpeg and ffprobe on PATH (or FFMPEG_PATH / FFPROBE_PATH). Without them it says so
 * once and stays idle rather than failing repeatedly.
 */
import mongoose from 'mongoose'
import { connectToDatabase } from '../src/server/db/mongoose.ts'
import { makeWorkerId } from '../src/server/lib/transcode-queue.ts'
import { drainQueue, startTranscodeWorker } from '../src/server/lib/transcode-worker.ts'
import { hasFfmpeg } from '../src/server/lib/ffmpeg.ts'

const once = process.argv.includes('--once')

async function main() {
  await connectToDatabase()

  if (!(await hasFfmpeg())) {
    console.error('ffmpeg/ffprobe not found on PATH. Install it, or set FFMPEG_PATH/FFPROBE_PATH.')
    console.error('On Windows: winget install Gyan.FFmpeg')
    process.exitCode = 1
    return
  }

  if (once) {
    const done = await drainQueue(makeWorkerId())
    console.log(done === 0 ? 'Nothing queued.' : `Transcoded ${done} video(s).`)
    await mongoose.disconnect()
    return
  }

  const worker = startTranscodeWorker()

  // Stop scheduling on the way out. The encode in flight is abandoned rather than awaited:
  // its lease simply expires and the next worker picks the video up, which is the same path
  // a crash takes and therefore the one already proven to work.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\nReceived ${signal}, stopping.`)
      worker.stop()
      void mongoose.disconnect().finally(() => process.exit(0))
    })
  }

  console.log('Polling for work. Ctrl-C to stop.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
