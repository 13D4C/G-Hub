import { createHash, randomBytes } from 'node:crypto'

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const VALID_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
const CALLBACK_PATH = '/api/auth/google/callback'

export interface GoogleConfig {
  clientId: string
  clientSecret: string
}

export interface GoogleProfile {
  /** Google's stable, unique account id. */
  sub: string
  email: string
  emailVerified: boolean
  name: string
}

export function getGoogleConfig(): GoogleConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set. Add them to your .env file (see .env.example).',
    )
  }

  return { clientId, clientSecret }
}

/**
 * The redirect URI must match one registered in the Google Cloud console exactly.
 * Derived from the incoming request so local dev works without extra config;
 * set GOOGLE_REDIRECT_URI when running behind a proxy that rewrites the host.
 */
export function getRedirectUri(request: Request): string {
  return process.env.GOOGLE_REDIRECT_URI ?? new URL(CALLBACK_PATH, request.url).href
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

export function createState(): string {
  return base64url(randomBytes(32))
}

export function createCodeVerifier(): string {
  return base64url(randomBytes(32))
}

export function toCodeChallenge(codeVerifier: string): string {
  return base64url(createHash('sha256').update(codeVerifier).digest())
}

export function buildAuthorizationUrl(options: {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
}): string {
  const url = new URL(AUTHORIZATION_ENDPOINT)
  url.searchParams.set('client_id', options.clientId)
  url.searchParams.set('redirect_uri', options.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', options.state)
  url.searchParams.set('code_challenge', options.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  // Ask for a fresh account choice rather than silently reusing the only signed-in Google account.
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

interface TokenResponse {
  id_token?: string
  access_token?: string
}

export async function exchangeCodeForIdToken(options: {
  code: string
  codeVerifier: string
  redirectUri: string
  config: GoogleConfig
}): Promise<string> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: options.code,
      client_id: options.config.clientId,
      client_secret: options.config.clientSecret,
      redirect_uri: options.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: options.codeVerifier,
    }),
  })

  if (!response.ok) {
    throw new Error(`Google token exchange failed (${response.status}): ${await response.text()}`)
  }

  const tokens = (await response.json()) as TokenResponse
  if (!tokens.id_token) {
    throw new Error('Google token response did not include an id_token.')
  }

  return tokens.id_token
}

interface IdTokenClaims {
  iss?: string
  aud?: string
  exp?: number
  sub?: string
  email?: string
  email_verified?: boolean
  name?: string
}

/**
 * The id_token came straight from Google's token endpoint over TLS, so per OpenID
 * Connect §3.1.3.7 the signature does not need re-verifying — but the claims still do.
 */
export function parseIdToken(idToken: string, config: GoogleConfig): GoogleProfile {
  const payload = idToken.split('.')[1]
  if (!payload) {
    throw new Error('Malformed id_token returned by Google.')
  }

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as IdTokenClaims

  if (!claims.iss || !VALID_ISSUERS.includes(claims.iss)) {
    throw new Error('Unexpected id_token issuer.')
  }
  if (claims.aud !== config.clientId) {
    throw new Error('id_token was not issued for this client.')
  }
  if (!claims.exp || claims.exp * 1000 <= Date.now()) {
    throw new Error('id_token has expired.')
  }
  if (!claims.sub || !claims.email) {
    throw new Error('id_token is missing the subject or email claim.')
  }

  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    emailVerified: claims.email_verified === true,
    name: claims.name ?? '',
  }
}
