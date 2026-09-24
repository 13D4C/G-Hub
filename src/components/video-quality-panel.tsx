import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  AUTO_QUALITY_ID,
  formatKbps,
  formatRenditionLabel,
  type QualityOption,
  type SelectableRendition,
} from '@/lib/video-quality'
import { isTranscodeSettled, type TranscodeStatus } from '@/lib/transcode-status'

type VideoQualityPanelProps = {
  options: QualityOption[]
  /** The pinned rendition's height, or null for Auto. */
  selectedHeight: number | null
  onSelect: (height: number | null) => void
  /** What is playing right now, read from the engine rather than assumed. */
  active: SelectableRendition | null
  /** Whether the adaptive engine is actually in charge of this playback. */
  adaptive: boolean
  transcodeStatus?: TranscodeStatus | null
}

/**
 * Why there is nothing to choose, or empty when there is.
 *
 * Worth as much care as the working state. Every reason below looks identical from the
 * outside — a row of buttons that change nothing — so a menu that silently did nothing would
 * be indistinguishable from one that was broken.
 */
function unavailableReason(
  adaptive: boolean,
  options: QualityOption[],
  transcodeStatus: TranscodeStatus | null | undefined,
): string {
  if (!adaptive) {
    if (transcodeStatus && !isTranscodeSettled(transcodeStatus)) {
      return 'Playing the original upload — quality options appear once processing finishes.'
    }
    // Null means this video was never queued, which is every upload that predates the
    // pipeline. Saying "once processing finishes" here would promise something that is
    // never going to happen on its own.
    if (transcodeStatus === null) {
      return 'Playing the original upload. This video has not been prepared for adaptive streaming.'
    }
    if (transcodeStatus === 'failed' || transcodeStatus === 'skipped') {
      return 'Playing the original upload. No adaptive renditions were produced for this video.'
    }
    // What is left is a browser handling the stream itself, where the operating system picks
    // the rendition and there is nothing here to drive.
    return 'This browser is handling stream quality itself.'
  }

  // One rendition plus Auto: a menu, but not a choice.
  if (options.length < 3) {
    return 'Only one quality is available for this video.'
  }

  return ''
}

/**
 * The quality menu, and a readout of what is actually playing.
 *
 * The readout is not redundant with the menu, because the two can legitimately differ. On
 * `Auto` the menu says nothing about which rendition won — that is the engine's decision,
 * made from measured throughput and changing as the connection does, and watching it move is
 * the whole point of adaptive streaming. Pinned, they agree, and the readout is then the
 * confirmation that the pin took.
 */
export function VideoQualityPanel({
  options,
  selectedHeight,
  onSelect,
  active,
  adaptive,
  transcodeStatus,
}: VideoQualityPanelProps) {
  const reason = unavailableReason(adaptive, options, transcodeStatus)
  const disabled = reason !== ''

  return (
    <div className="flex flex-col gap-3 border-t border-white/10 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-white/60">Quality</span>

        {/* Announced, because on Auto this changes by itself as the connection does, and a
            change nobody is told about is a change a screen reader user cannot observe. */}
        <span aria-live="polite" className="text-xs text-white/70">
          {active ? (
            <>
              Playing{' '}
              <span className="font-semibold text-white">{formatRenditionLabel(active)}</span>
              <span className="text-white/50"> · {formatKbps(active.bandwidth)}</span>
              {selectedHeight === null && <span className="text-white/40"> · chosen for you</span>}
            </>
          ) : (
            <span className="text-white/50">Original upload</span>
          )}
        </span>
      </div>

      {disabled ? (
        <p className="text-xs text-white/50">{reason}</p>
      ) : (
        <div role="radiogroup" aria-label="Video quality" className="flex flex-wrap gap-2">
          {options.map((option) => {
            const selected = option.height === selectedHeight
            // On Auto, mark whichever rendition the player settled on, so the menu shows the
            // outcome of the automatic choice rather than looking inert.
            const isAutoChoice =
              selectedHeight === null && option.height !== null && option.height === active?.height

            return (
              <Button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                size="sm"
                variant="outline"
                title={option.detail || 'Let the player choose, and change as the connection does'}
                onClick={() => onSelect(option.height)}
                className={cn(
                  'border-white/20 bg-white/5 text-white hover:bg-white/15 hover:text-white',
                  selected && 'border-sky-400 bg-sky-500/20 text-white hover:bg-sky-500/25',
                  !selected && isAutoChoice && 'border-white/40 text-white',
                )}
              >
                {option.label}
                {option.id !== AUTO_QUALITY_ID && !selected && isAutoChoice && (
                  <span className="ml-1 text-[10px] text-white/50">•</span>
                )}
              </Button>
            )
          })}
        </div>
      )}
    </div>
  )
}
