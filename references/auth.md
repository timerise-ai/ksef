# Authentication and token lifecycle

## The architectural decision that shapes everything else

KSeF offers two authentication methods:

1. **XAdES signature** — sign an `AuthTokenRequest` XML document with a
   qualified certificate, Trusted Profile (Profil Zaufany), or KSeF
   certificate. Requires an XML-DSig/XAdES implementation.
2. **KSeF token** — encrypt a previously issued KSeF token with the MF public
   key. Requires only `node:crypto` RSA-OAEP.

**Never put XAdES in your Next.js runtime path.** There is no maintained
official TypeScript XAdES implementation, and you do not need one:

- Bootstrap **once, out-of-band**: authenticate with XAdES using a qualified
  signature / Trusted Profile / the official test-cert demo app (on TEST — see
  [errors-limits-and-testing.md](errors-limits-and-testing.md)), then mint a
  **KSeF token** (see
  [certificates-tokens-permissions.md](certificates-tokens-permissions.md)).
- Store that KSeF token as a secret (env var or encrypted DB column).
- At runtime, your app authenticates with `POST /auth/ksef-token` using pure
  Node crypto, on every environment.

A KSeF certificate (type `Authentication`) is an alternative bootstrap product
that can also be used for XAdES auth and is verified faster than qualified
certificates on PRD — but obtaining it still requires one XAdES-signed
enrollment, so the bootstrap-once principle stands.

## Concepts

- **Context (`contextIdentifier`)** — the entity you act *for*, usually a
  company NIP: `{ "type": "Nip", "value": "1111111111" }`. Other types:
  `InternalId`, `NipVatUe`, `PeppolId`.
- **Authenticating subject** — who is logging in. With KSeF-token auth this is
  derived from the token itself. The subject must hold at least one active
  permission in the chosen context.
- **`accessToken`** — short-lived JWT (minutes) used as `Authorization: Bearer`
  on all protected endpoints. Its lifetime is whatever `exp` says — **decode
  the JWT, never hardcode a TTL**.
- **`refreshToken`** — valid up to 7 days, used only against
  `POST /auth/token/refresh` to obtain fresh access tokens.
- Tokens are invalidated automatically when the subject loses permissions. An
  access token stays valid until `exp` even if permissions change in the
  meantime — permissions are evaluated at issue time.

## Runtime flow (KSeF token)

```
POST /auth/challenge                      → { challenge, timestamp, timestampMs, clientIp }
   ↓  encrypt `${ksefToken}|${timestampMs}` with MF key (usage KsefTokenEncryption)
POST /auth/ksef-token                     → 202 { referenceNumber, authenticationToken }
   ↓  poll with Bearer = authenticationToken.token
GET  /auth/{referenceNumber}              → status.code 100 → 200
   ↓  once 200, redeem — ONE TIME ONLY
POST /auth/token/redeem                   → { accessToken, refreshToken }
   ↓  when accessToken nears exp
POST /auth/token/refresh  (Bearer = refreshToken) → { accessToken }
```

Details that matter:

- The challenge is valid **10 minutes**; `timestampMs` is the challenge's Unix
  time in milliseconds — the same number you embed in the encrypted string.
- `POST /auth/ksef-token` body:

  ```json
  {
    "challenge": "20261231-CR-0123456789-0123456789-AB",
    "contextIdentifier": { "type": "Nip", "value": "1111111111" },
    "encryptedToken": "BASE64...",
    "publicKeyId": "44-char id of the MF key used",
    "authorizationPolicy": { "allowedIps": { "ip4Addresses": ["203.0.113.10"] } }
  }
  ```

  `authorizationPolicy` (optional) IP-restricts use of the resulting tokens —
  **skip it on Vercel**, where function egress IPs are not stable.
- Poll `GET /auth/{referenceNumber}` with the **temporary**
  `authenticationToken` as Bearer. Status codes: `100` in progress, `200`
  success, `415` no permissions in context, `425` revoked, `450` bad token
  (wrong challenge/timestamp/encryption, revoked or inactive token, token not
  valid in this context), `460` certificate problem, `480` blocked for
  suspected security incident. On DEMO/PRD, qualified-certificate methods wait
  for OCSP/CRL checks; KSeF-token and KSeF-certificate auth verify quickly.
- **Surface `status.description`/`status.details` verbatim on failure —
  never replace them with your own guess.** `450` covers several unrelated
  causes and only the description distinguishes them. A token minted for a
  different NIP reports something like *"Token nie może być użyty w kontekście
  {NIP}"* ("token cannot be used in context {NIP}") — the fix is to correct
  `KSEF_CONTEXT_NIP` (or the tenant's stored context), **not** to mint a new
  token. An app-level message like "token invalid or inactive" sends operators
  to re-mint a token they did not need.
- `POST /auth/token/redeem` (Bearer = authenticationToken) works **exactly
  once** per authentication — a second call returns 400. Persist both tokens
  immediately.
- `POST /auth/token/refresh` (Bearer = **refreshToken**) returns a new access
  token reflecting *current* permissions. When the refresh token nears its
  ≤7-day expiry (`validUntil`), run the full flow again.

## TypeScript implementation

Uses `getMfPublicKey`, `encryptKsefToken`, `ksefFetch` from
[crypto-and-client.md](crypto-and-client.md).

```typescript
// lib/ksef/auth.ts
import 'server-only';
import { getMfPublicKey } from './public-keys';
import { encryptKsefToken } from './crypto';
import { ksefFetch } from './client';

interface TokenInfo { token: string; validUntil: string }

export interface KsefTokens {
  accessToken: TokenInfo;
  refreshToken: TokenInfo;
  authReferenceNumber: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function authenticateWithKsefToken(opts: {
  baseUrl: string;         // e.g. https://api-test.ksef.mf.gov.pl/v2
  ksefToken: string;       // from env/secret store — never log it
  contextNip: string;
}): Promise<KsefTokens> {
  const { baseUrl, ksefToken, contextNip } = opts;

  const challenge = await ksefFetch<{ challenge: string; timestampMs: number }>(
    baseUrl, '/auth/challenge', { method: 'POST' },
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

  // Poll until the authentication completes (usually well under a minute).
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = await ksefFetch<{
      status: { code: number; description?: string; details?: string[] };
    }>(
      baseUrl, `/auth/${init.referenceNumber}`,
      { accessToken: init.authenticationToken.token },
    );
    if (status.status.code === 200) break;
    if (status.status.code > 200) {
      // Pass KSeF's own wording through — e.g. 450 "token cannot be used in
      // context {NIP}" means wrong context, not a dead token.
      const detail = [status.status.description, ...(status.status.details ?? [])]
        .filter(Boolean).join(' — ');
      throw new Error(`KSeF authentication failed: ${status.status.code} ${detail}`);
    }
    if (Date.now() > deadline) throw new Error('KSeF authentication timed out');
    await sleep(1_000);
  }

  const tokens = await ksefFetch<{ accessToken: TokenInfo; refreshToken: TokenInfo }>(
    baseUrl, '/auth/token/redeem',
    { method: 'POST', accessToken: init.authenticationToken.token },
  );

  return { ...tokens, authReferenceNumber: init.referenceNumber };
}
```

### Reading the JWT expiry

```typescript
export function jwtExpiryMs(jwt: string): number {
  const payload = JSON.parse(
    Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'),
  ) as { exp?: number };
  if (!payload.exp) throw new Error('JWT has no exp claim');
  return payload.exp * 1000;
}
```

### Serverless token manager

Serverless functions share nothing, so persist tokens in your database
(encrypted at rest) and refresh on demand. Guard against stampedes — two
concurrent invocations both refreshing is harmless (refresh tokens are
reusable), but two concurrent *full re-auths* waste rate limit, so prefer a
lock or `ON CONFLICT` upsert.

```typescript
// Pseudocode outline — adapt persistence to your DB (see architecture-and-vercel.md)
const EXPIRY_MARGIN_MS = 60_000;

export async function getValidAccessToken(tenantId: string): Promise<string> {
  const creds = await loadCredentials(tenantId); // { accessToken, refreshToken, ksefToken, contextNip }

  if (creds.accessToken && jwtExpiryMs(creds.accessToken) - EXPIRY_MARGIN_MS > Date.now()) {
    return creds.accessToken;
  }

  if (creds.refreshToken && Date.parse(creds.refreshTokenValidUntil) > Date.now()) {
    const { accessToken } = await ksefFetch<{ accessToken: TokenInfo }>(
      creds.baseUrl, '/auth/token/refresh',
      { method: 'POST', accessToken: creds.refreshToken },
    );
    await saveAccessToken(tenantId, accessToken);
    return accessToken.token;
  }

  const tokens = await authenticateWithKsefToken({
    baseUrl: creds.baseUrl,
    ksefToken: creds.ksefToken,
    contextNip: creds.contextNip,
  });
  await saveTokens(tenantId, tokens);
  return tokens.accessToken.token;
}
```

## Managing authentication sessions

Each successful authentication opens an "auth session" tied to its
`referenceNumber` and refresh token:

| Endpoint | Purpose |
|---|---|
| `GET /auth/sessions` | List active auth sessions (paged with `continuationToken`) |
| `DELETE /auth/sessions/current` | Revoke the session the current token belongs to |
| `DELETE /auth/sessions/{referenceNumber}` | Revoke a specific session |

Revocation invalidates the refresh token; already-issued access tokens keep
working until `exp`. Revoke sessions when rotating credentials or
off-boarding a tenant.

## Appendix: XAdES bootstrap (what happens out-of-band)

You only touch this when minting the KSeF token / enrolling a certificate:

1. `POST /auth/challenge` → challenge.
2. Build `AuthTokenRequest` XML (namespace
   `http://ksef.mf.gov.pl/auth/token/2.0`) containing the challenge, the
   `ContextIdentifier` (Nip / InternalId / NipVatUe) and
   `SubjectIdentifierType` (`certificateSubject` or `certificateFingerprint`).
3. Sign it XAdES enveloped/enveloping (detached is rejected) with a qualified
   certificate, Trusted Profile, or KSeF certificate. RSA ≥2048 or EC P-256.
4. `POST /auth/xades-signature` (body: the signed XML) → same
   poll → redeem flow as above.
5. While authenticated, `POST /tokens` to mint the KSeF token for runtime use.

Practical ways to perform step 3 without writing XAdES code:

- **TEST**: the official demo app generates a self-signed test certificate and
  performs the whole flow — see the bootstrap walkthrough in
  [errors-limits-and-testing.md](errors-limits-and-testing.md).
- **PRD**: authenticate once through the official KSeF web application (KAP —
  Aplikacja Podatnika, login via Trusted Profile or qualified signature) and
  generate the KSeF token there, or run the flow with your qualified
  certificate using the official C#/Java client libraries.

## Sources

- [Authentication (uwierzytelnianie.md)](https://github.com/CIRFMF/ksef-api/blob/main/uwierzytelnianie.md)
- [Auth session management (auth/sesje.md)](https://github.com/CIRFMF/ksef-api/blob/main/auth/sesje.md)
- [XAdES requirements (auth/podpis-xades.md)](https://github.com/CIRFMF/ksef-api/blob/main/auth/podpis-xades.md)
- [KSeF tokens (tokeny-ksef.md)](https://github.com/CIRFMF/ksef-api/blob/main/tokeny-ksef.md)
