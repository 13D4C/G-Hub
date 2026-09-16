import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CloudUpload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { describeMutationError } from '@/lib/auth'
import { myMembershipTiersQueryOptions } from '@/lib/membership-tiers'
import {
  VIDEO_PRICE_DEFAULT_CENTS,
  VIDEO_PRICE_MAX_CENTS,
  VIDEO_PRICE_MIN_CENTS,
  parseVideoPrice,
} from '@/lib/video-price'
import {
  VIDEO_VISIBILITIES,
  VIDEO_VISIBILITY_HINTS,
  VIDEO_VISIBILITY_LABELS,
  type VideoVisibility,
} from '@/lib/video-visibility'
import { VISIBILITY_ICONS } from '@/lib/video-visibility-icons'
import { formatPrice } from '@/lib/channels'
import { myVideosQueryOptions } from '@/lib/videos'
import { createVideo } from '@/server/functions/videos'

export function UploadVideoForm({ onSuccess }: { onSuccess: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()

  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<VideoVisibility>('public')
  /** Empty means "any active subscriber", which is what premium meant before tiers. */
  const [requiredTierId, setRequiredTierId] = useState('')
  // Held as a major-unit string so the field behaves like a price, exactly as the tip
  // dialog's does. `parseVideoPrice` is the only thing that reads it.
  const [price, setPrice] = useState(() => (VIDEO_PRICE_DEFAULT_CENTS / 100).toFixed(2))
  const [isDragging, setIsDragging] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  // The uploader's own ladder. Fetched unconditionally rather than only once
  // "Private" is picked, so choosing it does not blank the select for a round trip.
  const { data: tiers } = useQuery(myMembershipTiersQueryOptions)

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const uploadMutation = useMutation({
    mutationFn: (formData: FormData) => createVideo({ data: formData }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: myVideosQueryOptions.queryKey })
      onSuccess()
    },
  })

  function handleFiles(files: FileList | null) {
    const next = files?.[0]
    if (!next) return
    if (!next.type.startsWith('video/')) {
      setValidationError('Please choose a video file')
      return
    }
    setValidationError(null)
    setFile(next)
    if (!title) {
      setTitle(next.name.replace(/\.[^/.]+$/, ''))
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragging(false)
    handleFiles(e.dataTransfer.files)
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragging(true)
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!file) {
      setValidationError('Please choose a video file')
      return
    }
    if (!title.trim()) {
      setValidationError('Please give it a title')
      return
    }
    // Stopped here as well as on the server, so a price the server would refuse never
    // costs the creator an upload they have to repeat.
    if (visibility === 'buyer' && priceCents === null) {
      setValidationError(
        `Enter a price between ${formatPrice(VIDEO_PRICE_MIN_CENTS, 'usd')} and ${formatPrice(VIDEO_PRICE_MAX_CENTS, 'usd')}`,
      )
      return
    }

    setValidationError(null)
    const formData = new FormData()
    formData.set('file', file)
    formData.set('title', title)
    formData.set('description', description)
    formData.set('visibility', visibility)
    // Each sent only for the visibility it belongs to; the server drops the other one
    // anyway, but leaving it out keeps the request saying exactly what the form shows.
    if (visibility === 'subscriber' && requiredTierId) {
      formData.set('requiredTierId', requiredTierId)
    }
    // Minor units on the wire — the decimal parsing happens here, so the server has
    // only to disbelieve an integer.
    if (visibility === 'buyer' && priceCents !== null) {
      formData.set('priceCents', String(priceCents))
    }
    uploadMutation.mutate(formData)
  }

  const priceCents = parseVideoPrice(price)
  const isUploading = uploadMutation.isPending
  const error =
    validationError ??
    (uploadMutation.isError
      ? describeMutationError(uploadMutation.error, 'Could not upload your video. Please try again.')
      : null)

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={onDragOver}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-10 text-center transition-colors',
          isDragging ? 'border-sky-400 bg-sky-50' : 'border-slate-300 bg-slate-50 hover:bg-slate-100',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />

        {file ? (
          <>
            {previewUrl && (
              <video
                src={previewUrl}
                muted
                className="aspect-video w-full max-w-sm rounded-xl object-cover"
              />
            )}
            <p className="text-sm font-medium text-slate-700">{file.name}</p>
            <p className="text-xs text-slate-500">
              {(file.size / (1024 * 1024)).toFixed(1)} MB — click or drop to replace
            </p>
          </>
        ) : (
          <>
            <CloudUpload className={cn('size-10', isDragging ? 'text-sky-500' : 'text-slate-400')} />
            <p className="text-sm font-medium text-slate-700">Drag and drop a video here</p>
            <p className="text-xs text-slate-500">or click to browse your files</p>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-slate-700" htmlFor="title">
          Title
        </label>
        <input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="My totally normal video"
          className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-slate-700" htmlFor="description">
          Description
        </label>
        <textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          placeholder="What's this one about?"
          className="resize-none rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-slate-700">Visibility</span>
        {/* Two columns on a phone, four once there is room: a fourth audience does
            not fit the three-across row this used to be. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {VIDEO_VISIBILITIES.map((option) => {
            const Icon = VISIBILITY_ICONS[option]
            return (
              <Button
                key={option}
                type="button"
                variant="outline"
                onClick={() => setVisibility(option)}
                className={cn(
                  'justify-center gap-2',
                  visibility === option &&
                    'border-sky-400 bg-sky-50 text-sky-700 hover:bg-sky-50 hover:text-sky-700',
                )}
              >
                <Icon className="size-4" />
                {VIDEO_VISIBILITY_LABELS[option]}
              </Button>
            )
          })}
        </div>
        <p className="text-xs text-slate-500">{VIDEO_VISIBILITY_HINTS[visibility]}</p>
      </div>

      {/* Only meaningful for a `subscriber` upload — a public video is open to
          everyone and a private one to nobody, so a tier on either is a rule nothing
          reads and the control does not exist for them. */}
      {visibility === 'subscriber' ? (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="requiredTierId">
            Required membership tier
          </label>
          <select
            id="requiredTierId"
            value={requiredTierId}
            onChange={(e) => setRequiredTierId(e.target.value)}
            className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-400"
          >
            <option value="">Any subscriber</option>
            {tiers?.map((tier) => (
              <option key={tier.id} value={tier.id}>
                {tier.name} (level {tier.rank})
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-500">
            {tiers && tiers.length > 0
              ? 'Subscribers on this tier or any higher one can watch.'
              : 'You have no membership tiers yet — add them on your channel page to gate videos by tier.'}
          </p>
        </div>
      ) : null}

      {/* The other half of that rule: only a `buyer` upload carries a price, and it
          must carry one — a pay-per-view video with nothing on the ticket is a
          paywall its own checkout refuses to open. */}
      {visibility === 'buyer' ? (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="priceCents">
            Price
          </label>
          <input
            id="priceCents"
            // `inputMode` rather than `type="number"`, whose spinners and locale
            // handling fight a currency field — the same choice the tip dialog makes.
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm text-slate-900 outline-none focus:border-slate-400"
          />
          {/* Only once the creator has typed something unusable — an empty field on
              open is not an error yet. */}
          {price.trim() && priceCents === null ? (
            <p className="text-xs text-red-600">
              Enter a price between {formatPrice(VIDEO_PRICE_MIN_CENTS, 'usd')} and{' '}
              {formatPrice(VIDEO_PRICE_MAX_CENTS, 'usd')}.
            </p>
          ) : (
            <p className="text-xs text-slate-500">
              Charged once, in your channel currency. Whoever buys it keeps it — and a
              channel subscription does not include it.
            </p>
          )}
        </div>
      ) : null}

      {error && <p className="text-sm font-medium text-red-600">{error}</p>}

      <Button type="submit" size="lg" disabled={isUploading} className="mt-2">
        {isUploading ? 'Flushing…' : 'Flush it in'}
      </Button>
    </form>
  )
}
