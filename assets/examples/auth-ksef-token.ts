/**
 * Full runtime authentication flow with a KSeF token (no XAdES needed):
 * challenge → RSA-OAEP encrypt "token|timestampMs" → poll → redeem.
 *
 * Usage:
 *   KSEF_BASE_URL=https://api-test.ksef.mf.gov.pl/v2 \
 *   KSEF_CONTEXT_NIP=1111111111 \
 *   KSEF_KSEF_TOKEN=... \
 *   npx tsx auth-ksef-token.ts
 *
 * Secrets come from the environment — never hardcode or log them.
 */
import { encryptKsefToken, getMfPublicKey } from './crypto';
import { ksefFetch, requireEnv } from './ksef-client';

export interface TokenInfo {
  token: string;
  validUntil: string;
}

export interface KsefTokens {
  accessToken: TokenInfo;
  refreshToken: TokenInfo;
  authReferenceNumber: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function authenticateWithKsefToken(opts: {
  baseUrl: string;
  ksefToken: string;
  contextNip: string;
}): Promise<KsefTokens> {
  const { baseUrl, ksefToken, contextNip } = opts;

  const challenge = await ksefFetch<{ challenge: string; timestampMs: number }>(
    baseUrl,
    '/auth/challenge',
    { method: 'POST' },
  );

  const { key, publicKeyId } = await getMfPublicKey(baseUrl, 'KsefTokenEncryption');

  const init = await ksefFetch<{
    referenceNumber: string;
    authenticationToken: TokenInfo;
  }>(baseUrl, '/auth/ksef-token', {
    method: 'POST',
    body: {
      challenge: challenge.challenge,
      contextIdentifier: { type: 'Nip', value: contextNip },
      encryptedToken: encryptKsefToken(ksefToken, challenge.timestampMs, key),
      publicKeyId,
    },
  });

  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = await ksefFetch<{ status: { code: number; description?: string } }>(
      baseUrl,
      `/auth/${init.referenceNumber}`,
      { accessToken: init.authenticationToken.token },
    );
    if (status.status.code === 200) break;
    if (status.status.code > 200) {
      throw new Error(
        `KSeF authentication failed: ${status.status.code} ${status.status.description ?? ''}`,
      );
    }
    if (Date.now() > deadline) throw new Error('KSeF authentication timed out');
    await sleep(1_000);
  }

  // One-time redeem — a second call returns HTTP 400.
  const tokens = await ksefFetch<{ accessToken: TokenInfo; refreshToken: TokenInfo }>(
    baseUrl,
    '/auth/token/redeem',
    { method: 'POST', accessToken: init.authenticationToken.token },
  );

  return { ...tokens, authReferenceNumber: init.referenceNumber };
}

export async function refreshAccessToken(
  baseUrl: string,
  refreshToken: string,
): Promise<TokenInfo> {
  const res = await ksefFetch<{ accessToken: TokenInfo }>(baseUrl, '/auth/token/refresh', {
    method: 'POST',
    accessToken: refreshToken,
  });
  return res.accessToken;
}

/** Decode the exp claim (ms since epoch) — never hardcode token TTLs. */
export function jwtExpiryMs(jwt: string): number {
  const payload = JSON.parse(
    Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'),
  ) as { exp?: number };
  if (!payload.exp) throw new Error('JWT has no exp claim');
  return payload.exp * 1000;
}

// ---- CLI entry ----
if (process.argv[1]?.endsWith('auth-ksef-token.ts')) {
  authenticateWithKsefToken({
    baseUrl: requireEnv('KSEF_BASE_URL'),
    ksefToken: requireEnv('KSEF_KSEF_TOKEN'),
    contextNip: requireEnv('KSEF_CONTEXT_NIP'),
  })
    .then((t) => {
      // Do not print the tokens themselves — just proof of life and expiries.
      console.log('Authenticated. accessToken valid until:', t.accessToken.validUntil);
      console.log('refreshToken valid until:', t.refreshToken.validUntil);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
