import type { CSSProperties } from 'react'
import { Link } from '@tanstack/react-router'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { to: '/', label: 'Home' },
  { to: '/upload', label: 'Upload' },
] as const

const ROLL_STYLE: CSSProperties = {
  backgroundImage: 'linear-gradient(to bottom, #e6e6e6 0%, #ffffff 30%, #f0f0f0 70%, #cccccc 100%)',
}

const TUBE_STYLE: CSSProperties = {
  backgroundImage: 'radial-gradient(ellipse, #4a3623 20%, #a67c52 45%, #e6e6e6 55%, #b3b3b3 100%)',
}

const SHEET_STYLE: CSSProperties = {
  backgroundColor: '#fffdf7',
  backgroundImage:
    'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noiseFilter\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.8\' numOctaves=\'3\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noiseFilter)\' opacity=\'0.04\'/%3E%3C/svg%3E")',
}

const TEAR_MASK =
  'linear-gradient(-45deg, transparent 6px, black 6px), linear-gradient(45deg, transparent 6px, black 6px)'

const TEAR_STYLE: CSSProperties = {
  backgroundColor: '#fffdf7',
  WebkitMaskImage: TEAR_MASK,
  maskImage: TEAR_MASK,
  WebkitMaskSize: '12px 12px',
  maskSize: '12px 12px',
  WebkitMaskRepeat: 'repeat-x',
  maskRepeat: 'repeat-x',
  WebkitMaskPosition: 'left bottom',
  maskPosition: 'left bottom',
}

interface SidebarProps {
  open: boolean
  onToggle: () => void
}

export function RollTrigger({ open, onToggle }: SidebarProps) {
  return (
    <div className="shrink-0 pl-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="app-sidebar"
        aria-label={open ? 'Roll up sidebar' : 'Drop down sidebar'}
        style={ROLL_STYLE}
        className="relative z-10 h-14 w-44 cursor-pointer rounded-md shadow-[0_8px_14px_-4px_rgba(0,0,0,0.45)] ring-1 ring-black/10 transition-transform active:scale-[0.98]"
      >
        <span
          aria-hidden="true"
          style={TUBE_STYLE}
          className="absolute top-1 -right-1.5 h-12 w-3.5 rounded-full shadow-[inset_-2px_0_5px_rgba(0,0,0,0.1)]"
        />
      </button>
    </div>
  )
}

export function PaperFlyout({ open }: { open: boolean }) {
  return (
    <div
      id="app-sidebar"
      className={cn(
        '-mt-4 shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
        open ? 'w-44 delay-0' : 'w-0 delay-1000',
      )}
      aria-hidden={!open}
    >
      <div className="h-full w-44 pl-6">
        <div
          className={cn(
            'grid h-full w-38 transition-[grid-template-rows] duration-1000 ease-[cubic-bezier(0.25,1,0.5,1)]',
            open ? 'grid-rows-[1fr] delay-300' : 'grid-rows-[0fr] delay-0',
          )}
        >
          <div style={SHEET_STYLE} className="flex h-full min-h-0 flex-col overflow-hidden drop-shadow-[0_15px_10px_rgba(0,0,0,0.2)]">
            <ul className="m-0 shrink-0 list-none pt-4">
              {NAV_ITEMS.map(({ to, label }) => (
                <li key={to} className="border-b-2 border-dashed border-black/10 text-center">
                  <Link
                    to={to}
                    tabIndex={open ? undefined : -1}
                    className="block px-4 py-3.5 text-xs font-bold tracking-wider text-slate-600 uppercase transition hover:bg-black/3 hover:text-slate-900 [&.active]:text-primary"
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="min-h-0 flex-1" />
            <div aria-hidden="true" style={TEAR_STYLE} className="h-3 shrink-0" />
          </div>
        </div>
      </div>
    </div>
  )
}
