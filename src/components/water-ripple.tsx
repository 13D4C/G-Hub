import { useEffect, useRef, type CSSProperties } from 'react'

const TEXTURE_SRC = '/texture/shitty-tiles.jpg'
const BAKE_SIZE = 512
const TILE_SCREEN_PX = 400
const MAX_POINTER_SPEED = 2

function bakeTileTexture(image: HTMLImageElement): string {
  const canvas = document.createElement('canvas')
  canvas.width = BAKE_SIZE
  canvas.height = BAKE_SIZE
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(image, 0, 0, BAKE_SIZE, BAKE_SIZE)
  return canvas.toDataURL('image/png')
}

const stageStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  backgroundRepeat: 'repeat',
  backgroundPosition: '0px 0px',
  backgroundSize: `${TILE_SCREEN_PX}px ${TILE_SCREEN_PX}px`,
}

export function WaterRippleLayer() {
  const stageRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) return

    let disposed = false
    let teardown: (() => void) | undefined

    async function setup() {
      const [{ default: $ }] = await Promise.all([
        import('jquery'),
        import('jquery.ripples'),
      ])
      if (disposed || !stage) return

      const withGlobals = window as unknown as { jQuery: typeof $; $: typeof $ }
      withGlobals.jQuery = $
      withGlobals.$ = $

      const image = new Image()
      const loaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = reject
      })
      image.src = TEXTURE_SRC
      await loaded
      if (disposed || !stage) return

      const bakedUrl = bakeTileTexture(image)

      const $stage = $(stage)
      $stage.ripples({
        imageUrl: bakedUrl,
        resolution: 380,
        dropRadius: 22,
        perturbance: 0.02,
        interactive: false,
      })

      let last: { x: number; y: number } | null = null

      function onPointerMove(e: PointerEvent) {
        const rect = stage!.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top

        if (last) {
          const dx = x - last.x
          const dy = y - last.y
          const speed = Math.min(Math.sqrt(dx * dx + dy * dy), MAX_POINTER_SPEED)
          if (speed > 0.3) {
            const strength = Math.min(0.05, 0.015 + speed * 0.004)
            $stage.ripples('drop', x, y, 20, strength)
          }
        }
        last = { x, y }
      }

      function onPointerDown(e: PointerEvent) {
        const rect = stage!.getBoundingClientRect()
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top
        $stage.ripples('drop', x, y, 45, 0.09)
      }

      function onResize() {
        $stage.ripples('updateSize')
      }

      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerdown', onPointerDown)
      window.addEventListener('resize', onResize)

      teardown = () => {
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerdown', onPointerDown)
        window.removeEventListener('resize', onResize)
        $stage.ripples('destroy')
      }
    }

    setup().catch(() => {})

    return () => {
      disposed = true
      teardown?.()
    }
  }, [])

  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      <div ref={stageRef} style={stageStyle} />
      <div className="underwater-tint absolute inset-0" />
      <div className="underwater-caustics absolute inset-0" />
      <div className="underwater-vignette absolute inset-0" />
    </div>
  )
}
