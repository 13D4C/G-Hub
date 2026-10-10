import 'jquery'

interface RipplesOptions {
  imageUrl?: string | null
  resolution?: number
  dropRadius?: number
  perturbance?: number
  interactive?: boolean
  crossOrigin?: string
}

declare global {
  interface JQuery {
    ripples(options: RipplesOptions): JQuery
    ripples(command: 'destroy' | 'show' | 'hide' | 'pause' | 'play' | 'updateSize'): JQuery
    ripples(command: 'drop', x: number, y: number, radius: number, strength: number): JQuery
    ripples(
      command: 'set',
      name: keyof RipplesOptions,
      value: RipplesOptions[keyof RipplesOptions],
    ): JQuery
  }
}

export {}
