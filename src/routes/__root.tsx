import { Link, Outlet, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: RootLayout,
})

function RootLayout() {
  return (
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
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
