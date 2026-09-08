import { useSession } from '@tanstack/react-start/server'
import type { SessionConfig } from '@tanstack/start-server-core'

export interface AuthSessionData {
  userId: string
}

/** Short-lived cookie that carries the OAuth CSRF state + PKCE verifier across the round trip to Google. */
export interface OAuthSessionData {
  state: string
  codeVerifier: string
  redirectTo: string
}

const SESSION_SECRET = process.env.SESSION_SECRET

function getSessionConfig(name: string, maxAge: number): SessionConfig {
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    throw new Error(
      'SESSION_SECRET is not set (or is shorter than 32 chars). Add it to your .env file (see .env.example).',
    )
  }

  return {
    password: SESSION_SECRET,
    name,
    maxAge,
    cookie: { sameSite: 'lax' },
  }
}

/** Not a React hook — just named to satisfy the `react-hooks/rules-of-hooks` lint rule, which the underlying `useSession` triggers. */
export function useAuthSession() {
  return useSession<AuthSessionData>(getSessionConfig('auth', 60 * 60 * 24 * 7)) // 7 days
}

/** Not a React hook — see `useAuthSession`. */
export function useOAuthSession() {
  return useSession<OAuthSessionData>(getSessionConfig('oauth', 60 * 10)) // 10 minutes
}
