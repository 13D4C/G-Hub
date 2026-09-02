import { HeadContent, Link, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import appCss from '@/index.css?url'
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
        <div className="min-h-svh flex flex-col">
          <header className="border-b">
            <nav className="mx-auto flex max-w-4xl items-center gap-4 px-4 py-3">
              <Link to="/" className="font-semibold [&.active]:text-primary">
                G-Hub
              </Link>
              <Link to="/video" className="text-muted-foreground [&.active]:text-foreground">
                Video
              </Link>
            </nav>
          </header>
          <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">{children}</main>
        </div>
        <Scripts />
      </body>
    </html>
  )
}
