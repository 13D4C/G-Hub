import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouter } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { meQueryOptions } from '@/lib/auth'
import { billingStatusQueryOptions } from '@/lib/billing'
import { logout } from '@/server/functions/auth'

export function AuthNav() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: user } = useQuery(meQueryOptions)

  const signOut = useMutation({
    mutationFn: () => logout(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: meQueryOptions.queryKey })
      // Plan status is per-viewer, so it must not survive a sign-out.
      await queryClient.invalidateQueries({ queryKey: billingStatusQueryOptions.queryKey })
      await router.navigate({ to: '/' })
    },
  })

  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/login">Sign in</Link>
        </Button>
        <Button asChild size="sm">
          <Link to="/register">Sign up</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground">{user.name || user.email}</span>
      <Button asChild variant="ghost" size="sm">
        <Link to="/billing">Billing</Link>
      </Button>
      <Button variant="outline" size="sm" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
        {signOut.isPending ? 'Signing out…' : 'Sign out'}
      </Button>
    </div>
  )
}
