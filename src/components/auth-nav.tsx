import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useRouter } from '@tanstack/react-router'
import { LogOut, Tv } from 'lucide-react'
import { meQueryOptions } from '@/lib/auth'
import { logout } from '@/server/functions/auth'

const FALLBACK_AVATAR = '/assets/skibidi.jpg'

const avatarClassName =
  'block size-9 shrink-0 overflow-hidden rounded-full ring-2 ring-white/70 transition hover:ring-primary'

export function AuthNav() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: user } = useQuery(meQueryOptions)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const signOut = useMutation({
    mutationFn: () => logout(),
    onSuccess: async () => {
      setOpen(false)
      await queryClient.invalidateQueries({ queryKey: meQueryOptions.queryKey })
      await router.navigate({ to: '/' })
    },
  })

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!user) {
    return (
      <Link to="/login" aria-label="Sign in" className={avatarClassName}>
        <img src={FALLBACK_AVATAR} alt="" className="size-full object-cover" />
      </Link>
    )
  }

  return (
    <div ref={rootRef} className="relative isolate z-50">
      <button
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={avatarClassName}
      >
        <img src={user.avatarUrl || FALLBACK_AVATAR} alt="" className="size-full object-cover" />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-50 mt-2 w-48 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <p className="truncate px-2 py-1.5 text-sm font-medium">{user.name || user.email}</p>
          <div className="-mx-1 my-1 h-px bg-border" />
          {/* The only route to your own channel page, where the subscription price
              is set — without it a creator can upload premium videos but never
              price them. */}
          <Link
            to="/channel"
            search={{ id: user.id }}
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent"
          >
            <Tv className="size-4" />
            Your channel
          </Link>
          <div className="-mx-1 my-1 h-px bg-border" />
          <button
            type="button"
            role="menuitem"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-destructive outline-none hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
          >
            <LogOut className="size-4" />
            {signOut.isPending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
