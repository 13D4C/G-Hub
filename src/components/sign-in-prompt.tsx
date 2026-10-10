import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'

/**
 * Offered in place of an action that needs an account, so a signed-out viewer is
 * invited to sign in rather than shown an error after the fact.
 */
export function SignInPrompt({ redirect, label }: { redirect: string; label: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      {/* `safeInternalPath` accepts any path starting with a single "/", so the
          viewer lands back where they were. */}
      <Link to="/login" search={{ redirect }}>
        {label}
      </Link>
    </Button>
  )
}
