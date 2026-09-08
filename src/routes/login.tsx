import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { LoginForm, RegisterForm } from '@/components/auth-forms'
import { Card } from '@/components/ui/card'
import { meQueryOptions } from '@/lib/auth'
import { safeInternalPath } from '@/lib/redirect'

const authSearchSchema = z.object({
  mode: z.enum(['login', 'register']).catch('login').default('login'),
  redirect: z.string().optional().catch(undefined),
  /** Set by the Google callback when the OAuth round trip fails. */
  authError: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/login')({
  validateSearch: authSearchSchema,
  beforeLoad: async ({ context, search }) => {
    const user = await context.queryClient.ensureQueryData(meQueryOptions)
    if (user) throw redirect({ href: safeInternalPath(search.redirect) })
  },
  component: AuthPage,
})

function AuthPage() {
  const { mode, redirect: redirectTo, authError } = Route.useSearch()

  return (
    <div className="mx-auto w-full max-w-sm">
      <Card>
        {mode === 'register' ? (
          <RegisterForm redirectTo={redirectTo} />
        ) : (
          <LoginForm redirectTo={redirectTo} authError={authError} />
        )}
      </Card>
    </div>
  )
}
