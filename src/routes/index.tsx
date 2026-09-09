import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatPrice } from '@/lib/channels'
import { listChannels } from '@/server/functions/channels'
import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  // Channel summaries are viewer-independent — no `subscribed` flag, no unlocked
  // list — so unlike `/channel` this is plain loader data with no per-viewer key.
  loader: () => listChannels(),
  component: HomePage,
})

function HomePage() {
  const channels = Route.useLoaderData()

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>G-Hub</CardTitle>
          <CardDescription>
            TanStack Router/Query + Zod + shadcn/ui + Tailwind CSS + Video.js starter.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/video">Open video demo</Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Channels</CardTitle>
          <CardDescription>Subscribe to unlock a creator&rsquo;s premium videos.</CardDescription>
        </CardHeader>
        <CardContent>
          {channels.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No channels are accepting subscribers yet — run the seed script to create the
              demo channel.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {channels.map((channel) => (
                <li key={channel.creatorId}>
                  <Link
                    to="/channel"
                    search={{ id: channel.creatorId }}
                    className="flex items-baseline justify-between gap-4 rounded-md border px-3 py-2 hover:bg-accent"
                  >
                    <span>
                      <span className="block font-medium">{channel.name}</span>
                      <span className="block text-sm text-muted-foreground">
                        {channel.videoCount} video{channel.videoCount === 1 ? '' : 's'}
                        {channel.premiumCount ? `, ${channel.premiumCount} premium` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-medium">
                      {formatPrice(channel.priceCents, channel.currency)}/mo
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
