import { useState } from 'react'
import { HeadContent, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import appCss from '@/index.css?url'
import { Navbar } from '@/components/navbar'
import { PaperFlyout } from '@/components/sidebar'
import { WaterRippleLayer } from '@/components/water-ripple'
import { meQueryOptions } from '@/lib/auth'
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
  // Resolve the session once per navigation so the header and the auth route
  // guards read the same cached `me` result.
  loader: ({ context }) => context.queryClient.ensureQueryData(meQueryOptions),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div className="bg-underwater-base flex min-h-full flex-col text-slate-100">
          <WaterRippleLayer />
          <div className="relative z-10 flex flex-1 flex-col">
            <Navbar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)} />

            <div className="flex min-h-0 flex-1">
              <PaperFlyout open={sidebarOpen} />
              <main className="mx-auto w-full max-w-375 min-w-0 flex-1 px-4 py-4">{children}</main>
            </div>
          </div>
        </div>
        <Scripts />
      </body>
    </html>
  )
}
