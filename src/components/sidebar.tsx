import type { CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { meQueryOptions } from '@/lib/auth'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { to: '/', label: 'Home', requiresAuth: false },
  { to: '/subscribed', label: 'Subscribed', requiresAuth: true },
  { to: '/dashboard', label: 'Dashboard', requiresAuth: false },
] as const

const PAPER_BACKGROUND: CSSProperties = {
  backgroundColor: '#fffdf7',
  backgroundImage: 'url(/texture/toiletpaper.jpg)',
  backgroundSize: '200px',
  backgroundRepeat: 'repeat',
  backgroundPosition: 'center',
  boxShadow:
    'inset 0 1px 0 rgba(255,255,255,0.9), inset 0 -16px 24px -20px rgba(15,23,42,0.18), 0 20px 45px -18px rgba(0,0,0,0.5)',
}

const ROLL_STYLE: CSSProperties = PAPER_BACKGROUND

const TUBE_STYLE: CSSProperties = {
  backgroundImage: 'radial-gradient(ellipse, #4a3623 20%, #a67c52 45%, #e6e6e6 55%, #b3b3b3 100%)',
}

const TEETH =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='22' viewBox='0 0 18 22'%3E%3Cpolygon points='0,0 18,0 18,4 9,22 0,4' fill='%23fff'/%3E%3C/svg%3E\")"

const SHEET_MASK = `linear-gradient(#000, #000), ${TEETH}`

const SHEET_STYLE: CSSProperties = {
  ...PAPER_BACKGROUND,
  WebkitMaskImage: SHEET_MASK,
  maskImage: SHEET_MASK,
  WebkitMaskSize: '100% calc(100% - 21px), 18px 22px',
  maskSize: '100% calc(100% - 21px), 18px 22px',
  WebkitMaskRepeat: 'no-repeat, repeat-x',
  maskRepeat: 'no-repeat, repeat-x',
  WebkitMaskPosition: 'left top, left bottom',
  maskPosition: 'left top, left bottom',
}

interface SidebarProps {
  open: boolean
  onToggle: () => void
}

export function RollTrigger({ open, onToggle }: SidebarProps) {
  return (
    <div className="flex shrink-0 self-end pl-3">
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
  const { data: user } = useQuery(meQueryOptions)
  const navItems = NAV_ITEMS.filter((item) => !item.requiresAuth || user)

  return (
    <div
      id="app-sidebar"
      className={cn(
        'sticky top-20 h-[64svh] shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]',
        open ? 'w-44 delay-0' : 'w-0 delay-500',
      )}
      aria-hidden={!open}
    >
      <div className="h-full w-44 pl-6">
        <div
          style={SHEET_STYLE}
          className={cn(
            'flex w-38 flex-col drop-shadow-[0_15px_10px_rgba(0,0,0,0.35)]',
            'transition-[height] duration-700 ease-[cubic-bezier(0.25,1,0.5,1)]',
            open ? 'h-full delay-200' : 'h-0 delay-0',
          )}
        >
          <ul className="m-0 shrink-0 list-none pt-4">
            {navItems.map(({ to, label }) => (
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
        </div>
      </div>
    </div>
  )
}
