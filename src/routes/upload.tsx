import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { CloudUpload, Globe, Lock } from 'lucide-react'

export const Route = createFileRoute('/upload')({
  component: UploadPage,
})

type UploadFormValues = {
  file: File
  title: string
  description: string
  visibility: 'public' | 'private'
}

async function submitUpload(values: UploadFormValues) {
  const formData = new FormData()
  formData.set('file', values.file)
  formData.set('title', values.title)
  formData.set('description', values.description)
  formData.set('visibility', values.visibility)
}

function UploadPage() {
  const inputRef = useRef<HTMLInputElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'private'>('public')
  const [isDragging, setIsDragging] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const uploadMutation = useMutation({ mutationFn: submitUpload })

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

    setValidationError(null)
    uploadMutation.mutate({ file, title, description, visibility })
  }

  const isUploading = uploadMutation.isPending
  const error =
    validationError ?? (uploadMutation.error instanceof Error ? uploadMutation.error.message : null)

  return (
    <Card variant="glass" className="sm:p-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        <div>
          <h1 className="font-display text-3xl font-semibold text-white">Flush in a new video</h1>
        </div>

        <Card asChild className="flex flex-col gap-6 p-6 sm:p-8">
          <form onSubmit={onSubmit}>
            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={onDragOver}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-10 text-center transition-colors',
                isDragging
                  ? 'border-sky-400 bg-sky-50'
                  : 'border-slate-300 bg-slate-50 hover:bg-slate-100',
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
                  <CloudUpload
                    className={cn('size-10', isDragging ? 'text-sky-500' : 'text-slate-400')}
                  />
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
              <div className="grid grid-cols-2 gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setVisibility('public')}
                  className={cn(
                    'justify-center gap-2',
                    visibility === 'public' &&
                      'border-sky-400 bg-sky-50 text-sky-700 hover:bg-sky-50 hover:text-sky-700',
                  )}
                >
                  <Globe className="size-4" />
                  Public
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setVisibility('private')}
                  className={cn(
                    'justify-center gap-2',
                    visibility === 'private' &&
                      'border-sky-400 bg-sky-50 text-sky-700 hover:bg-sky-50 hover:text-sky-700',
                  )}
                >
                  <Lock className="size-4" />
                  Private
                </Button>
              </div>
            </div>

            {error && <p className="text-sm font-medium text-red-600">{error}</p>}

            <Button type="submit" size="lg" disabled={isUploading} className="mt-2">
              {isUploading ? 'Flushing…' : 'Flush it in'}
            </Button>
          </form>
        </Card>
      </div>
    </Card>
  )
}
