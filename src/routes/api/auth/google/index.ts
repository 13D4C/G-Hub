import { createFileRoute } from '@tanstack/react-router'
import {
  buildAuthorizationUrl,
  createCodeVerifier,
  createState,
  getGoogleConfig,
  getRedirectUri,
  toCodeChallenge,
} from '@/server/auth/google'
import { useOAuthSession } from '@/server/auth/session'
import { safeInternalPath } from '@/lib/redirect'

export const Route = createFileRoute('/api/auth/google/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const config = getGoogleConfig()
        const state = createState()
        const codeVerifier = createCodeVerifier()

        // eslint-disable-next-line react-hooks/rules-of-hooks -- not a React hook; see src/server/auth/session.ts
        const oauthSession = await useOAuthSession()
        await oauthSession.update({
          state,
          codeVerifier,
          redirectTo: safeInternalPath(new URL(request.url).searchParams.get('redirect')),
        })

        const authorizationUrl = buildAuthorizationUrl({
          clientId: config.clientId,
          redirectUri: getRedirectUri(request),
          state,
          codeChallenge: toCodeChallenge(codeVerifier),
        })

        return new Response(null, {
          status: 302,
          headers: { location: authorizationUrl },
        })
      },
    },
  },
})
