import { createFileRoute } from '@tanstack/react-router'
import { timingSafeEqual } from 'node:crypto'
import {
  exchangeCodeForIdToken,
  getGoogleConfig,
  getRedirectUri,
  parseIdToken,
  type GoogleProfile,
} from '@/server/auth/google'
import { isAllowedEmail } from '@/lib/email-domain'
import { useAuthSession, useOAuthSession } from '@/server/auth/session'
import { users } from '@/server/data'

function redirectTo(path: string): Response {
  return new Response(null, { status: 302, headers: { location: path } })
}

// The login page is the one that reads `authError` and shows the reason; the home page ignores it.
function redirectWithError(reason: string): Response {
  return redirectTo(`/login?authError=${encodeURIComponent(reason)}`)
}

function matchesState(received: string, expected: string): boolean {
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Finds the account for a Google profile, linking or creating one as needed. */
async function resolveUser(profile: GoogleProfile) {
  const existingByGoogleId = await users.findByGoogleId(profile.sub)
  if (existingByGoogleId) {
    if (profile.avatarUrl && existingByGoogleId.avatarUrl !== profile.avatarUrl) {
      await users.setAvatar(existingByGoogleId.id, profile.avatarUrl)
    }
    return existingByGoogleId
  }

  // Google verified this email address, so it is safe to adopt an account that already uses it.
  const existingByEmail = await users.findByEmail(profile.email)
  if (existingByEmail) {
    await users.linkGoogle(existingByEmail.id, {
      googleId: profile.sub,
      name: existingByEmail.name ? undefined : profile.name,
      avatarUrl: profile.avatarUrl,
    })
    return existingByEmail
  }

  return users.create({
    email: profile.email,
    googleId: profile.sub,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
  })
}

export const Route = createFileRoute('/api/auth/google/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const params = new URL(request.url).searchParams
        // eslint-disable-next-line react-hooks/rules-of-hooks -- not a React hook; see src/server/auth/session.ts
        const oauthSession = await useOAuthSession()
        const { state, codeVerifier, redirectTo: destination = '/' } = oauthSession.data
        // The state cookie is single-use, whichever way this request turns out.
        await oauthSession.clear()

        const error = params.get('error')
        if (error) {
          // Includes `access_denied` when the user dismisses Google's consent screen.
          return redirectWithError(error)
        }

        const code = params.get('code')
        const receivedState = params.get('state')
        if (!code || !receivedState || !state || !codeVerifier) {
          return redirectWithError('invalid_callback')
        }
        if (!matchesState(receivedState, state)) {
          return redirectWithError('state_mismatch')
        }

        const config = getGoogleConfig()
        let profile: GoogleProfile
        try {
          const idToken = await exchangeCodeForIdToken({
            code,
            codeVerifier,
            redirectUri: getRedirectUri(request),
            config,
          })
          profile = parseIdToken(idToken, config)
        } catch (err) {
          // Details (client secret mismatch, replayed code, ...) belong in the logs, not the URL.
          console.error('Google sign-in failed:', err)
          return redirectWithError('google_sign_in_failed')
        }

        if (!profile.emailVerified) {
          return redirectWithError('email_not_verified')
        }

        if (!isAllowedEmail(profile.email)) {
          return redirectWithError('email_domain')
        }

        const user = await resolveUser(profile)

        // eslint-disable-next-line react-hooks/rules-of-hooks -- not a React hook; see src/server/auth/session.ts
        const session = await useAuthSession()
        await session.update({ userId: user.id })

        return redirectTo(destination)
      },
    },
  },
})
