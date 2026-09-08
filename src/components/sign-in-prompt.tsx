import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'

/**
 * Offered in place of an action that needs an account, so a signed-out viewer is
 * invited to sign in rather than shown an error after the fact.
 */
export function SignInPrompt({ videoId, label }: { videoId: string; label: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      {/* `safeInternalPath` accepts this because it starts with a single "/", so the
          viewer lands back on the video they were watching. */}
      <Link to="/login" search={{ redirect: `/video?id=${videoId}` }}>
        {label}
      </Link>
    </Button>
  )
}
