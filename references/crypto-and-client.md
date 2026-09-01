# Cryptography and HTTP client (Node.js / TypeScript)

Every other reference in this skill builds on the primitives defined here. All of
them are implementable with the built-in `node:crypto` module — no third-party
crypto dependencies are needed for the runtime path.

KSeF encryption model in one paragraph: every invoice (and every batch-package
part, and every export package) is encrypted with a **symmetric AES-256-CBC key
that you generate**. That AES key is itself encrypted ("wrapped") with the
**Ministry of Finance RSA public key** and sent to KSeF when you open a session
or request an export. Authentication with a KSeF token also uses the MF public
key (RSA-OAEP). Everything is hashed with SHA-256.

> Put these modules in something like `lib/ksef/` and add `import 'server-only'`
> at the top in a Next.js app — none of this code may ever reach the client
> bundle. See [architecture-and-vercel.md](architecture-and-vercel.md).

## 1. Ministry of Finance public keys

Fetch current public-key certificates from the (unauthenticated) endpoint:

```
GET {KSEF_BASE_URL}/security/public-key-certificates
```

Response is an array:

| Field | Meaning |
|---|---|
| `certificate` | X.509 certificate, DER, Base64-encoded |
| `certificateId` | Certificate identifier |
| `publicKeyId` | 44-char key identifier — pass it back in requests so KSeF knows which key you used |
| `validFrom` / `validTo` | Validity window |
| `usage` | Array: `SymmetricKeyEncryption` (wrapping session AES keys) and/or `KsefTokenEncryption` (encrypting KSeF tokens during auth) |

Rules:

- Select a certificate whose `usage` contains what you need and whose
  `validFrom`/`validTo` window covers now; when several match, prefer the newest
  `validFrom`.
- Cache the list (e.g. 24 h TTL) — do not fetch it per request.
- Always send the `publicKeyId` of the key you used (in `encryption.publicKeyId`
  or the auth request's `publicKeyId` field).
- **Key rotation**: KSeF re-certifies (same `publicKeyId`, new certificate) and
  rotates keys (new `publicKeyId`), sometimes on short notice. If a call fails
  with error code **21470** (unknown/withdrawn public key), drop the cache,
  re-fetch the certificates and retry once with the newest valid key.

```typescript
// lib/ksef/public-keys.ts
import 'server-only';
import { X509Certificate, type KeyObject } from 'node:crypto';

export type KeyUsage = 'SymmetricKeyEncryption' | 'KsefTokenEncryption';

export interface PublicKeyCertificate {
  certificate: string;    // DER, Base64
  certificateId: string;
  publicKeyId: string;    // 44 chars — echo back to KSeF
  validFrom: string;
  validTo: string;
  usage: KeyUsage[];
}

let cache: { fetchedAt: number; certs: PublicKeyCertificate[] } | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function getMfPublicKey(
  baseUrl: string,
  usage: KeyUsage,
  opts: { forceRefresh?: boolean } = {},
): Promise<{ key: KeyObject; publicKeyId: string }> {
  if (opts.forceRefresh || !cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
    const res = await fetch(`${baseUrl}/security/public-key-certificates`);
    if (!res.ok) throw new Error(`Failed to fetch MF public keys: HTTP ${res.status}`);
    cache = { fetchedAt: Date.now(), certs: (await res.json()) as PublicKeyCertificate[] };
  }
  const now = Date.now();
  const candidates = cache.certs
    .filter(
      (c) =>
        c.usage.includes(usage) &&
        Date.parse(c.validFrom) <= now &&
        now <= Date.parse(c.validTo),
    )
    .sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom));
  const chosen = candidates[0];
  if (!chosen) throw new Error(`No valid MF public key for usage ${usage}`);
  const x509 = new X509Certificate(Buffer.from(chosen.certificate, 'base64'));
  return { key: x509.publicKey, publicKeyId: chosen.publicKeyId };
}
```

## 2. Session encryption material

Generate a fresh AES key per session (recommended by the docs) and per export:

- symmetric key: **32 bytes** (AES-256),
- initialization vector: **16 bytes**.

```typescript
// lib/ksef/crypto.ts
import 'server-only';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
  constants,
  type KeyObject,
} from 'node:crypto';

export interface SessionEncryption {
  cipherKey: Buffer; // 32 bytes, keep server-side only
  iv: Buffer;        // 16 bytes
}

export function generateSessionEncryption(): SessionEncryption {
  return { cipherKey: randomBytes(32), iv: randomBytes(16) };
}
```

## 3. AES-256-CBC document encryption

Algorithm: **AES-256-CBC with PKCS#7 padding** (Node's `createCipheriv` pads
with PKCS#7 by default).

> ### The IV is transmitted, never embedded
>
> **Send the raw ciphertext. Do not prepend the IV to it.** The IV crosses the
> wire exactly once, Base64-encoded in `encryption.initializationVector` when
> you open a session or request an export, and KSeF reuses that one IV for
> every invoice, every batch part, and the export package of that session.
>
> **Beware: the official docs are wrong here.** `sesja-interaktywna.md` and
> `sesja-wsadowa.md` both describe the IV as *"dołączany jako prefiks do
> szyfrogramu"* (attached as a prefix to the ciphertext). That clause dates
> from the docs repo's initial commit and contradicts every official client:
> C# `CryptographyService.EncryptBytesWithAES256` returns the `CryptoStream`
> output alone, and Java's `encryptBytesWithAes256` is a bare
> `return cipher.doFinal(content)`. Neither client concatenates or strips a
> 16-byte prefix anywhere, including the E2E tests that run against the live
> TEST environment.
>
> Prepending it fails in a way that points at the wrong field: KSeF decrypts
> 16 bytes too many, so the plaintext it recovers is longer than your declared
> `invoiceSize` and you get invoice status **430** — *"Rozmiar faktury nie
> zgadza się z zadeklarowaną wartością"* (invoice size does not match the
> declared value). Chasing the size fields never finds it. Status **435**
> (decryption error) is the other possible outcome.

```typescript
/** Encrypt a document for KSeF: raw AES-256-CBC ciphertext, no IV prefix. */
export function encryptDocument(plaintext: Buffer, enc: SessionEncryption): Buffer {
  const cipher = createCipheriv('aes-256-cbc', enc.cipherKey, enc.iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * Decrypt a payload received from KSeF (e.g. an export package part) with the
 * key and IV you supplied in the export request — nothing to strip.
 */
export function decryptDocument(
  encrypted: Buffer, cipherKey: Buffer, iv: Buffer,
): Buffer {
  const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
```

Hash and size always describe **that same ciphertext**: `encryptedInvoiceHash`
= Base64(SHA-256(ciphertext)), `encryptedInvoiceSize` = `ciphertext.byteLength`.

## 4. Wrapping the AES key (RSAES-OAEP)

The AES key is encrypted with the MF public key using **RSAES-OAEP with SHA-256
and MGF1-SHA-256** (Node's `oaepHash: 'sha256'` sets both), then Base64-encoded:

```typescript
export function wrapSymmetricKey(cipherKey: Buffer, mfPublicKey: KeyObject): string {
  return publicEncrypt(
    { key: mfPublicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    cipherKey,
  ).toString('base64');
}
```

The resulting object sent to KSeF (used by sessions and exports):

```typescript
export interface EncryptionInfo {
  encryptedSymmetricKey: string; // Base64(RSA-OAEP(cipherKey))
  initializationVector: string;  // Base64(iv)
  publicKeyId?: string;          // which MF key you used
}

export function buildEncryptionInfo(
  enc: SessionEncryption,
  mfPublicKey: KeyObject,
  publicKeyId: string,
): EncryptionInfo {
  return {
    encryptedSymmetricKey: wrapSymmetricKey(enc.cipherKey, mfPublicKey),
    initializationVector: enc.iv.toString('base64'),
    publicKeyId,
  };
}
```

## 5. Hashes and file metadata

SHA-256 everywhere. The API wants Base64; QR links want **Base64URL**
(`Buffer.toString('base64url')`, no padding).

```typescript
export function sha256Base64(data: Buffer): string {
  return createHash('sha256').update(data).digest('base64');
}

export function sha256Base64Url(data: Buffer): string {
  return createHash('sha256').update(data).digest('base64url');
}

export interface FileMetadata {
  hashSha256Base64: string;
  sizeBytes: number;
}

/** Hash + size, needed for both the plaintext and the encrypted document. */
export function fileMetadata(data: Buffer): FileMetadata {
  return { hashSha256Base64: sha256Base64(data), sizeBytes: data.byteLength };
}
```

When sending an invoice you must provide metadata of **both** forms of the file:
the plaintext XML (`invoiceHash`, `invoiceSize`) and the encrypted file —
ciphertext only — (`encryptedInvoiceHash`, `encryptedInvoiceSize`). See
[sending-interactive.md](sending-interactive.md).

## 6. KSeF-token encryption (runtime authentication)

To authenticate with a KSeF token you encrypt the string
`{ksefToken}|{challengeTimestampMs}` — token and the challenge's Unix
timestamp in **milliseconds**, joined by a pipe — with the MF public key whose
usage is `KsefTokenEncryption`, RSA-OAEP SHA-256, Base64-encoded:

```typescript
export function encryptKsefToken(
  ksefToken: string,
  challengeTimestampMs: number,
  mfPublicKey: KeyObject,
): string {
  return publicEncrypt(
    { key: mfPublicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(`${ksefToken}|${challengeTimestampMs}`, 'utf8'),
  ).toString('base64');
}
```

Full auth flow (challenge → encrypt → poll → redeem → refresh): [auth.md](auth.md).

## 7. Typed fetch client

A thin wrapper around `fetch` that injects the bearer token, parses KSeF's
error envelope, honors `Retry-After` on 429, and retries transient failures
with jittered backoff:

```typescript
// lib/ksef/client.ts
import 'server-only';

export class KsefApiError extends Error {
  constructor(
    public httpStatus: number,
    public body: unknown,
    message?: string,
  ) {
    super(message ?? `KSeF API error: HTTP ${httpStatus}`);
  }
  /**
   * KSeF error code if the body carries one (e.g. 21470).
   * `exceptionDetailList` sits under `exception`, not at the body root.
   * `errors[]` is the RFC 9457 shape (opt in with `X-Error-Format: problem-details`);
   * the legacy `exception` envelope still ships but is marked deprecated.
   */
  get ksefCode(): number | undefined {
    const b = this.body as {
      exception?: { exceptionDetailList?: Array<{ exceptionCode?: number }> };
      errors?: Array<{ code?: number }>;
    } | null;
    return b?.exception?.exceptionDetailList?.[0]?.exceptionCode ?? b?.errors?.[0]?.code;
  }
}

export interface KsefFetchOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  accessToken?: string;   // Bearer token for protected endpoints
  maxRetries?: number;    // default 3 (429 + 5xx + network)
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ksefFetch<T>(
  baseUrl: string,
  path: string,
  opts: KsefFetchOptions = {},
): Promise<T> {
  const { method = 'GET', body, accessToken, maxRetries = 3, signal } = opts;
  let attempt = 0;

  for (;;) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      signal,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const contentType = res.headers.get('content-type') ?? '';
      return (contentType.includes('json') ? await res.json() : await res.text()) as T;
    }

    const errorBody = await res.json().catch(() => null);

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxRetries) {
      attempt += 1;
      const retryAfterSec = Number(res.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : Math.min(30_000, 2 ** attempt * 1000) + Math.random() * 500;
      await sleep(delayMs);
      continue;
    }

    throw new KsefApiError(res.status, errorBody);
  }
}
```

Usage notes:

- **429 handling is not optional.** Rate limits are enforced per
  (context, IP) with sliding windows and the block duration escalates on
  repeated violations — see
  [errors-limits-and-testing.md](errors-limits-and-testing.md).
- On a Vercel function, cap total retry time well below the function's
  `maxDuration`; prefer persisting state and letting the next cron tick retry
  over long in-function sleeps.
- Batch **part uploads** and UPO/export **download URLs** must be called
  exactly as returned by the API and **without** the `Authorization` header —
  use plain `fetch`, not this wrapper.

## 8. Error 21470 — stale public key

Wrap encryption-dependent calls so a `21470` triggers one refresh-and-retry:

```typescript
export async function withFreshMfKey<T>(
  fn: (forceRefresh: boolean) => Promise<T>,
): Promise<T> {
  try {
    return await fn(false);
  } catch (e) {
    if (e instanceof KsefApiError && e.ksefCode === 21470) {
      return await fn(true); // re-fetch MF keys, rebuild EncryptionInfo, retry once
    }
    throw e;
  }
}
```

## 9. Why there is no XAdES code here

XML signatures (XAdES) are required only to **bootstrap** credentials —
one-time, out-of-band operations like generating a KSeF token or enrolling a
KSeF certificate. They should never be in your Next.js runtime path, so this
skill deliberately ships no XAdES implementation. See
[auth.md](auth.md) for the bootstrap-once pattern and
[errors-limits-and-testing.md](errors-limits-and-testing.md) for how to
bootstrap on the TEST environment.

## Sources

- [Public encryption keys (klucze-publiczne-do-szyfrowania.md)](https://github.com/CIRFMF/ksef-api/blob/main/bezpieczenstwo/klucze-publiczne-do-szyfrowania.md)
- [Interactive session (sesja-interaktywna.md)](https://github.com/CIRFMF/ksef-api/blob/main/sesja-interaktywna.md) — encryption prerequisites
- [Authentication (uwierzytelnianie.md)](https://github.com/CIRFMF/ksef-api/blob/main/uwierzytelnianie.md)
