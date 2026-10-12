import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { GoogleSignInButton } from '@/components/google-sign-in-button'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { describeAuthError, describeMutationError, meQueryOptions } from '@/lib/auth'
import { safeInternalPath } from '@/lib/redirect'
import { login, register } from '@/server/functions/auth'

const MIN_PASSWORD_LENGTH = 8

function AuthDivider() {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs text-muted-foreground uppercase">or</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

export function LoginForm({ redirectTo, authError }: { redirectTo?: string; authError?: string }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const destination = safeInternalPath(redirectTo)

  const signIn = useMutation({
    mutationFn: (data: { email: string; password: string }) => login({ data }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: meQueryOptions.queryKey })
      await router.navigate({ href: destination })
    },
  })

  const errorMessage = signIn.isError
    ? describeMutationError(signIn.error, 'Could not sign in. Please try again.')
    : describeAuthError(authError)

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    signIn.mutate({
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    })
  }

  return (
    <div className="flex flex-col gap-6 py-6">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Welcome back to G-Hub.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <GoogleSignInButton redirectTo={destination} />

        <AuthDivider />

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>

          {errorMessage ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}

          <Button type="submit" disabled={signIn.isPending}>
            {signIn.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </CardContent>
    </div>
  )
}

export function RegisterForm({ redirectTo }: { redirectTo?: string }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const destination = safeInternalPath(redirectTo)
  const [validationError, setValidationError] = useState<string>()

  const signUp = useMutation({
    mutationFn: (data: { email: string; password: string; name?: string }) => register({ data }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: meQueryOptions.queryKey })
      await router.navigate({ href: destination })
    },
  })

  const errorMessage =
    validationError ??
    (signUp.isError
      ? describeMutationError(signUp.error, 'Could not create your account. Please try again.')
      : undefined)

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const password = String(form.get('password') ?? '')
    const name = String(form.get('name') ?? '').trim()

    if (password.length < MIN_PASSWORD_LENGTH) {
      setValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (password !== String(form.get('confirmPassword') ?? '')) {
      setValidationError('Passwords do not match.')
      return
    }

    setValidationError(undefined)
    signUp.mutate({
      email: String(form.get('email') ?? ''),
      password,
      name: name || undefined,
    })
  }

  return (
    <div className="flex flex-col gap-6 py-6">
      <CardHeader>
        <CardTitle>Create an account</CardTitle>
        <CardDescription>Join G-Hub with your @kmitl.ac.th email.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
            />
            <p className="text-xs text-muted-foreground">
              At least {MIN_PASSWORD_LENGTH} characters.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmPassword">Confirm password</Label>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
            />
          </div>

          {errorMessage ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}

          <Button type="submit" disabled={signUp.isPending}>
            {signUp.isPending ? 'Creating account…' : 'Create account'}
          </Button>
        </form>
      </CardContent>
    </div>
  )
}
