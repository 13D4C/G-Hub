import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
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
    </div>
  )
}
