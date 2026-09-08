import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouter } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { meQueryOptions } from '@/lib/auth'
import { logout } from '@/server/functions/auth'

export function AuthNav() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: user } = useQuery(meQueryOptions)

  const signOut = useMutation({
    mutationFn: () => logout(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: meQueryOptions.queryKey })
      await router.navigate({ to: '/' })
    },
  })

  if (!user) {
    return (
      <Link
        to="/login"
        aria-label="Sign in"
        className="block size-9 shrink-0 overflow-hidden rounded-full ring-2 ring-white/70 transition hover:ring-primary"
      >
        <img src="/assets/skibidi.jpg" alt="" className="size-full object-cover" />
      </Link>
    )
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground">{user.name || user.email}</span>
      <Button variant="outline" size="sm" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
        {signOut.isPending ? 'Signing out…' : 'Sign out'}
      </Button>
    </div>
  )
}
