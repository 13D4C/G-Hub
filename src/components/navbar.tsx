import { Link } from '@tanstack/react-router'
import { Search, Toilet, Upload } from 'lucide-react'
import { AuthNav } from '@/components/auth-nav'
import { RollTrigger } from '@/components/sidebar'
import { Button } from '@/components/ui/button'

export function Navbar({
  sidebarOpen,
  onToggleSidebar,
}: {
  sidebarOpen: boolean
  onToggleSidebar: () => void
}) {
  return (
    <header className="bg-tile-navbar flex items-center border-b border-black/15 shadow-md">
      <RollTrigger open={sidebarOpen} onToggle={onToggleSidebar} />

      <nav className="mx-auto flex max-w-6xl flex-1 items-center gap-3 px-4 py-3">
        <div className="flex w-full items-center gap-3 rounded-full bg-white/80 py-2 pl-4 pr-2 shadow-md backdrop-blur-sm sm:gap-4">
          <Link
            to="/"
            className="font-display flex shrink-0 items-center gap-2 text-lg font-semibold text-slate-800 [&.active]:text-primary"
          >
            <Toilet className="size-6" />
            G-Hub
          </Link>

          <div className="hidden h-6 w-px shrink-0 bg-slate-300 sm:block" />

          <div className="relative hidden min-w-0 flex-1 sm:block">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              placeholder="Search videos"
              className="w-full rounded-full bg-slate-100 py-2 pl-9 pr-4 text-sm text-slate-800 placeholder:text-slate-500 outline-none focus:bg-white"
            />
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-3">
            <Button asChild className="gap-2 rounded-full">
              <Link to="/upload">
                <Upload className="size-4" />
                Upload
              </Link>
            </Button>
            <AuthNav />
          </div>
        </div>
      </nav>
    </header>
  )
}
