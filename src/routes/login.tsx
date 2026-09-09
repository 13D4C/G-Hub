import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { LoginForm, RegisterForm } from '@/components/auth-forms'
import { Card } from '@/components/ui/card'
import { meQueryOptions } from '@/lib/auth'
import { safeInternalPath } from '@/lib/redirect'

const authSearchSchema = z.object({
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
  const { redirect: redirectTo, authError } = Route.useSearch()

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Card className="grid grid-cols-1 gap-0 divide-y divide-slate-200 p-0 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <LoginForm redirectTo={redirectTo} authError={authError} />
        <RegisterForm redirectTo={redirectTo} />
      </Card>
    </div>
  )
}
