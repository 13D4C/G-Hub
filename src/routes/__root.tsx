import { HeadContent, Link, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import appCss from '@/index.css?url'
import { Button } from '@/components/ui/button'
import { WaterRippleLayer } from '@/components/water-ripple'
import { Search, Toilet, Upload } from 'lucide-react'
import type { QueryClient } from '@tanstack/react-query'

interface MyRouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'G-Hub' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div className="bg-underwater-base flex min-h-svh flex-col text-slate-100">
          <WaterRippleLayer />
          <header className="bg-tile-navbar relative z-10 border-b border-black/15 shadow-md">
            <nav className="mx-auto flex max-w-6xl items-center px-4 py-3">
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

                <Button asChild className="ml-auto shrink-0 gap-2 rounded-full">
                  <Link to="/upload">
                    <Upload className="size-4" />
                    Upload
                  </Link>
                </Button>
              </div>
            </nav>
          </header>
          <main className="relative z-10 mx-auto w-full max-w-screen-2xl flex-1 px-4 py-8">
            {children}
          </main>
        </div>
        <Scripts />
      </body>
    </html>
  )
}
