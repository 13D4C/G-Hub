import { Button } from '@/components/ui/button'

function GoogleIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" className="size-4">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.34A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  )
}

/**
 * Starts the server-side OAuth flow. This must be a real navigation (not fetch),
 * so the browser follows the redirect to Google and keeps the state cookie.
 */
export function GoogleSignInButton({ redirectTo = '/' }: { redirectTo?: string }) {
  const href = `/api/auth/google?redirect=${encodeURIComponent(redirectTo)}`

  return (
    <Button asChild variant="outline" className="w-full">
      <a href={href}>
        <GoogleIcon />
        Continue with Google
      </a>
    </Button>
  )
}
