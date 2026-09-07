import { createFileRoute } from '@tanstack/react-router'
import { timingSafeEqual } from 'node:crypto'
import {
  exchangeCodeForIdToken,
  getGoogleConfig,
  getRedirectUri,
  parseIdToken,
  type GoogleProfile,
} from '@/server/auth/google'
import { useAuthSession, useOAuthSession } from '@/server/auth/session'
import { UserModel } from '@/server/db/models/user'
import { connectToDatabase } from '@/server/db/mongoose'

function redirectTo(path: string): Response {
  return new Response(null, { status: 302, headers: { location: path } })
}

function redirectWithError(reason: string): Response {
  return redirectTo(`/?authError=${encodeURIComponent(reason)}`)
}

function matchesState(received: string, expected: string): boolean {
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Finds the account for a Google profile, linking or creating one as needed. */
async function resolveUser(profile: GoogleProfile) {
  const existingByGoogleId = await UserModel.findOne({ googleId: profile.sub })
  if (existingByGoogleId) return existingByGoogleId

  // Google verified this email address, so it is safe to adopt an account that already uses it.
  const existingByEmail = await UserModel.findOne({ email: profile.email })
  if (existingByEmail) {
    existingByEmail.googleId = profile.sub
    if (!existingByEmail.name) existingByEmail.name = profile.name
    await existingByEmail.save()
    return existingByEmail
  }

  return UserModel.create({
    email: profile.email,
    googleId: profile.sub,
    name: profile.name,
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

        await connectToDatabase()
        const user = await resolveUser(profile)

        // eslint-disable-next-line react-hooks/rules-of-hooks -- not a React hook; see src/server/auth/session.ts
        const session = await useAuthSession()
        await session.update({ userId: String(user._id) })

        return redirectTo(destination)
      },
    },
  },
})
