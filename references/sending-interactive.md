# Sending invoices — interactive session, status and UPO

Interactive (online) sessions submit invoices one at a time and are meant for
low-volume, latency-sensitive flows (POS, single corrections, "send now"
buttons). For anything that batches naturally, prefer a batch session — it is
dramatically cheaper against rate limits
([sending-batch.md](sending-batch.md)).

Prerequisites: a valid `accessToken` ([auth.md](auth.md)) with `InvoiceWrite`
permission, and the crypto helpers from
[crypto-and-client.md](crypto-and-client.md).

## Invoice files

- FA(3) XML, UTF-8 **without BOM**, valid against the published XSD. FA(2) is
  accepted on TEST only.
- Max size 1 MB (3 MB with attachments; attachments are batch-only, need prior
  opt-in via e-Urząd Skarbowy, and are exempt only for technical corrections).
- Up to 10 000 invoices per session.
- The system detects **duplicates by business data**, not file hash:
  seller NIP (`Podmiot1`) + invoice kind (`RodzajFaktury`) + invoice number
  (`P_2`). A duplicate gets invoice status **440** with the original KSeF
  number in `status.extensions` (see [§3.1](#31-reading-a-rejection)).
  Coordinate invoice numbering across branches/systems that share a NIP.

## Pre-send validation

Three checks, all cheap, that between them prevent the most common rejections
and the most expensive mistake. Run them before you even open a session.

**1. NIPs are 10 bare digits.** The FA(3) type `TNrNIP` is `[1-9]((\d[1-9])|([1-9]\d))\d{7}`
— no dashes, spaces, or `PL` prefix. The usual cause of a violation is a
display helper (`formatNip()` → `123-456-32-18`) reaching the XML builder.
**Build XML from raw domain values; apply presentation formatting only in the
UI layer.** A separator here surfaces as invoice status `430`, whose
description mentions schema validation but not which field.

**2. The NIP checksum is valid.** Invalid NIPs sail through the XSD (the
pattern is syntax-only) and fail later, often first on a correction.

**3. The seller NIP equals the authenticating context NIP.** `Podmiot1` usually
comes from your tenant profile while the token authenticates a separate stored
context — nothing links the two. Check at settings-save time *and* again before
each send, since the profile can change afterwards.

```typescript
// lib/ksef/nip.ts
import 'server-only';

/** Digits only — accepts "123-456-32-18", "PL1234563218", "1234563218". */
export function normalizeNip(input: string): string {
  return input.replace(/\D/g, '');
}

/** NIP checksum: weights 6,5,7,2,3,4,5,6,7 over the first 9 digits, mod 11. */
export function isValidNip(input: string): boolean {
  const d = normalizeNip(input);
  if (!/^[1-9]\d{9}$/.test(d)) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(d[i]), 0) % 11;
  return sum !== 10 && sum === Number(d[9]);
}

/** True when both identify the same taxpayer, ignoring formatting. */
export function sameNip(a: string, b: string): boolean {
  return normalizeNip(a) === normalizeNip(b) && normalizeNip(a).length === 10;
}

/** Value ready for a TNrNIP element — throws rather than emitting bad XML. */
export function toTNrNip(input: string): string {
  const d = normalizeNip(input);
  if (!isValidNip(d)) throw new Error('Invalid NIP (format or checksum)');
  return d;
}
```

Wire the context check into the send path, not only into settings:

```typescript
const creds = await loadKsefCredentials(tenantId);
if (!creds) throw new Error('KSeF is not configured for this tenant');
if (!sameNip(invoice.sellerNip, creds.contextNip)) {
  throw new Error(
    `Seller NIP ${invoice.sellerNip} does not match the KSeF context ` +
    `${creds.contextNip} — refusing to file this invoice under another taxpayer`,
  );
}
```

Validating the built XML against the published XSD in CI catches (1) and much
of what `430` otherwise reports only as a generic verification error:

```bash
xmllint --noout --schema schemat-FA-3.xsd invoice.xml
```

## 1. Open a session

```
POST /sessions/online
```

```json
{
  "formCode": { "systemCode": "FA (3)", "schemaVersion": "1-0E", "value": "FA" },
  "encryption": {
    "encryptedSymmetricKey": "BASE64...",
    "initializationVector": "BASE64...",
    "publicKeyId": "..."
  }
}
```

Supported `formCode` values (from the OpenAPI spec):

| Schema | systemCode | schemaVersion | value |
|---|---|---|---|
| FA(2) — TEST only | `FA (2)` | `1-0E` | `FA` |
| FA(3) | `FA (3)` | `1-0E` | `FA` |
| PEF(3) | `PEF (3)` | `2-1` | `PEF` |
| PEF_KOR(3) | `PEF_KOR (3)` | `2-1` | `PEF` |
| FA_RR(1) | `FA_RR (1)` | `1-1E` | `FA_RR` |

Response `201`: `{ referenceNumber, validUntil }`. Opening is synchronous and
cheap; sessions live **12 hours**; multiple concurrent sessions per
authentication are fine. Generate a **fresh AES key per session**.

## 2. Send an invoice

```
POST /sessions/online/{referenceNumber}/invoices
```

```json
{
  "invoiceHash": "SHA-256 of the plaintext XML, Base64",
  "invoiceSize": 12345,
  "encryptedInvoiceHash": "SHA-256 of the encrypted file, Base64",
  "encryptedInvoiceSize": 12384,
  "encryptedInvoiceContent": "Base64(AES-256-CBC ciphertext — no IV prefix)",
  "offlineMode": false,
  "hashOfCorrectedInvoice": null
}
```

- `encryptedInvoice*` fields describe the **raw ciphertext** (what
  `encryptDocument()` returns) — the IV was already sent in the session's
  `encryption` object and must **not** be prepended here. Doing so returns
  `430` complaining about the *size*, not the encryption
  ([crypto-and-client.md](crypto-and-client.md#3-aes-256-cbc-document-encryption)).
- `offlineMode: true` declares an offline-issued invoice
  ([qr-codes-and-offline.md](qr-codes-and-offline.md));
  `hashOfCorrectedInvoice` is only used for technical corrections.
- Response `202`: `{ referenceNumber }` — the invoice's reference number
  within this session. Verification is **asynchronous** from here.

```typescript
// lib/ksef/send-online.ts
import 'server-only';
import { ksefFetch } from './client';
import {
  buildEncryptionInfo, encryptDocument, fileMetadata,
  generateSessionEncryption, type SessionEncryption,
} from './crypto';
import { getMfPublicKey } from './public-keys';

export async function openOnlineSession(baseUrl: string, accessToken: string) {
  const enc = generateSessionEncryption();
  const { key, publicKeyId } = await getMfPublicKey(baseUrl, 'SymmetricKeyEncryption');
  const session = await ksefFetch<{ referenceNumber: string; validUntil: string }>(
    baseUrl, '/sessions/online', {
      method: 'POST',
      accessToken,
      body: {
        formCode: { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' },
        encryption: buildEncryptionInfo(enc, key, publicKeyId),
      },
    },
  );
  return { ...session, enc };
}

export async function sendInvoice(
  baseUrl: string, accessToken: string,
  sessionRef: string, enc: SessionEncryption, invoiceXml: Buffer,
): Promise<{ referenceNumber: string }> {
  const encrypted = encryptDocument(invoiceXml, enc);
  const plain = fileMetadata(invoiceXml);
  const cipher = fileMetadata(encrypted);
  return ksefFetch(baseUrl, `/sessions/online/${sessionRef}/invoices`, {
    method: 'POST',
    accessToken,
    body: {
      invoiceHash: plain.hashSha256Base64,
      invoiceSize: plain.sizeBytes,
      encryptedInvoiceHash: cipher.hashSha256Base64,
      encryptedInvoiceSize: cipher.sizeBytes,
      encryptedInvoiceContent: encrypted.toString('base64'),
    },
  });
}
```

## 3. Poll invoice status

```
GET /sessions/{referenceNumber}/invoices/{invoiceReferenceNumber}
```

Invoice status codes (same for batch invoices):

| Code | Meaning |
|---|---|
| 100 | Accepted for processing |
| 150 | Processing |
| **200** | Success — `ksefNumber` assigned |
| 405 | Cancelled because the session failed |
| 410 | Insufficient permission scope |
| 415 | Attachments not allowed for this sender |
| 430 | File verification error (schema, hash, size, **or** encoding) |
| 435 | Decryption error |
| **440** | Duplicate — `status.extensions` carries `originalKsefNumber` / `originalSessionReferenceNumber` |
| 450 | Semantic validation error |
| 500 / 550 | Unknown error / cancelled by system — retry sending |

A successful response also carries `ksefNumber`, `acquisitionDate` (when the
KSeF number was assigned — this is the legal receipt date for the buyer),
`permanentStorageDate` (filled later, drives incremental sync — see
[receiving-and-sync.md](receiving-and-sync.md)) and, per poll, a fresh
short-lived `upoDownloadUrl`.

### 3.1 Reading a rejection

The status object is `{ code, description, details?, extensions? }` — and the
two optional fields are where the actual diagnosis lives:

```typescript
export interface InvoiceStatusInfo {
  code: number;
  description: string;          // e.g. "Błąd weryfikacji pliku faktury"
  details?: string[] | null;    // array of STRINGS — the specific reason
  extensions?: Record<string, string | null> | null; // object, NOT [{key,value}]
}
```

**Persist `description` and `details` alongside `code` on every rejection.**
A bare `430` is an umbrella covering schema violations, hash mismatch, size
mismatch and encoding errors at once; only the text tells you which one, and
without it a wrong-encryption bug reads as a size-declaration bug. This is the
single highest-value line of diagnostics in a KSeF integration — the difference
between a five-minute fix and a multi-day hunt.

```typescript
await db.markRejected(invoiceId, {
  code: st.status.code,
  error: [st.status.description, ...(st.status.details ?? [])].filter(Boolean).join(' | '),
});
```

`extensions` is a **string-keyed object**, not a list of `{key, value}` pairs.
Reading it as a list makes the duplicate path silently dead — the lookup
returns `undefined`, the invoice keeps no KSeF number, and nothing errors:

```typescript
// 440 — the invoice already exists in KSeF, filed by an earlier attempt.
if (st.status.code === 440) {
  const originalKsefNumber = st.status.extensions?.originalKsefNumber;
  const originalSessionRef = st.status.extensions?.originalSessionReferenceNumber;
  // Treat as success against the ORIGINAL identifiers, then fetch its UPO (§4).
}
```

Acceptance is usually near-instant. A sensible Vercel pattern: after sending,
short-poll for ~10–20 s inside `waitUntil()` to catch the common instant
acceptance, persist whatever state you reached, and let a cron tick finish the
stragglers ([architecture-and-vercel.md](architecture-and-vercel.md)).

Suggested local state machine:
`created → sent (have invoiceRef) → accepted (have ksefNumber) | rejected (code + details) → upo_stored`.

## 4. Retrieve UPO (Urzędowe Poświadczenie Odbioru)

UPO is the official, MF-signed XML receipt. Store it with the invoice — it is
the proof the invoice exists in KSeF.

Per invoice (once status = 200):

| Endpoint | Returns |
|---|---|
| `GET /sessions/{ref}/invoices/{invoiceRef}/upo` | UPO XML (`application/xml`) |
| `GET /sessions/{ref}/invoices/ksef/{ksefNumber}/upo` | UPO XML by KSeF number |
| `upoDownloadUrl` from a status response | UPO XML — plain `GET`, **no Authorization header**, not rate-limited, expires at `upoDownloadUrlExpirationDate`; response header `x-ms-meta-hash` = SHA-256 (Base64) of the document |

**Duplicates (440) need the *original* session's reference number.** A 440
means the invoice was accepted in some *earlier* session, so nothing in the
current session has a UPO: the current `invoiceRef` has none, and
`upoDownloadUrl` is absent from the 440 status. Resolve it through the
by-KSeF-number endpoint scoped to the original session:

```typescript
async function fetchUpoForDuplicate(
  baseUrl: string, accessToken: string,
  originalSessionRef: string, originalKsefNumber: string,
): Promise<string> {
  return ksefFetch<string>(
    baseUrl,
    `/sessions/${originalSessionRef}/invoices/ksef/${originalKsefNumber}/upo`,
    { accessToken },
  );
}
```

Two failure modes to avoid here, both silent:

- Resolving the UPO against the *current* session reference — it 404s, and if
  that fetch sits in a `catch(() => null)` the invoice lands in your database
  as fiscalised with an empty UPO: no legal proof of filing, no error anywhere.
  **Never swallow a UPO fetch failure** — leave the invoice in a retryable
  state and surface it.
- Marking the invoice complete without a UPO. Verify what you stored: the UPO
  XML's `NumerReferencyjnySesji` must equal the *original* session reference,
  and `NumerKSeFDokumentu` the original KSeF number.

Per session: after you close the session, KSeF generates a collective session
UPO. `GET /sessions/{referenceNumber}` then returns `upo.pages[]`, each with a
`downloadUrl` (a session UPO covers up to 10 000 invoices per page). Individual
per-invoice UPOs are the ones you typically hand to customers; the session UPO
is a convenient bulk artifact.

## 5. Close the session

```
POST /sessions/online/{referenceNumber}/close
```

Closing triggers asynchronous generation of the session UPO. You do not have to
close immediately — sessions expire after 12 h regardless — but only closed
sessions produce a session UPO. A session with zero invoices gets cancelled
(session status 440).

Session status codes: `100` open, `170` closed, `200` processed successfully,
`415` symmetric-key decryption failed (your `EncryptionInfo` was wrong), `440`
cancelled, `445` no valid invoices.
`GET /sessions` lists sessions; `GET /sessions/{ref}/invoices` (paged via
`continuationToken`) lists per-invoice outcomes;
`GET /sessions/{ref}/invoices/failed` returns only failures — useful for
reconciliation sweeps.

## End-to-end: Next.js server action

```typescript
// app/invoices/actions.ts
'use server';
import { after } from 'next/server';
import { getValidAccessToken } from '@/lib/ksef/auth';
import { openOnlineSession, sendInvoice } from '@/lib/ksef/send-online';
import { ksefFetch } from '@/lib/ksef/client';
import { db } from '@/lib/db';

const BASE = process.env.KSEF_BASE_URL!; // e.g. https://api-test.ksef.mf.gov.pl/v2

export async function submitInvoice(invoiceId: string) {
  const invoiceXml = await db.loadInvoiceXml(invoiceId);
  const accessToken = await getValidAccessToken('default');

  const { referenceNumber: sessionRef, enc } = await openOnlineSession(BASE, accessToken);
  const { referenceNumber: invoiceRef } = await sendInvoice(
    BASE, accessToken, sessionRef, enc, invoiceXml,
  );
  await db.markSent(invoiceId, { sessionRef, invoiceRef });

  // Post-response: catch the common instant acceptance without blocking the user.
  after(async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      const st = await ksefFetch<{ status: { code: number }; ksefNumber?: string }>(
        BASE, `/sessions/${sessionRef}/invoices/${invoiceRef}`, { accessToken },
      );
      if (st.status.code === 200 && st.ksefNumber) {
        await db.markAccepted(invoiceId, st.ksefNumber);
        return;
      }
      if (st.status.code > 200) {
        await db.markRejected(invoiceId, st.status.code);
        return;
      }
    }
    // Still processing — the status-poll cron will finish the job.
  });

  return { sessionRef, invoiceRef };
}
```

Session reuse: opening a session per invoice is fine at low volume (limit
10 open/s, 120/h). If you send bursts, keep one session open and reuse it —
persist `{ sessionRef, wrapped AES key material, validUntil }` server-side and
rotate before the 12 h expiry. Never reuse a session across tenants.

## KSeF number

Format (35 chars): `{NIP}-{YYYYMMDD}-{12 hex chars}-{2 hex chars CRC-8}`, e.g.
`5265877635-20250826-0100001AF629-AF`. The trailing byte is CRC-8
(poly `0x07`, init `0x00`) of the **32-character data part** — the hyphen
separating it from the checksum is *not* included — validate it when
accepting KSeF numbers from external sources:

```typescript
export function isValidKsefNumber(n: string): boolean {
  const m = /^(\d{10}-\d{8}-[0-9A-F]{12})-([0-9A-F]{2})$/.exec(n);
  if (!m) return false;
  const data = Buffer.from(m[1]!, 'ascii');
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc.toString(16).toUpperCase().padStart(2, '0') === m[2];
}
```

## Sources

- [Interactive session (sesja-interaktywna.md)](https://github.com/CIRFMF/ksef-api/blob/main/sesja-interaktywna.md)
- [Session status and UPO (sesja-sprawdzenie-stanu-i-pobranie-upo.md)](https://github.com/CIRFMF/ksef-api/blob/main/faktury/sesje/sesja-sprawdzenie-stanu-i-pobranie-upo.md)
- [Invoice verification rules (weryfikacja-faktury.md)](https://github.com/CIRFMF/ksef-api/blob/main/faktury/weryfikacja-faktury.md)
- [KSeF number (numer-ksef.md)](https://github.com/CIRFMF/ksef-api/blob/main/faktury/numer-ksef.md)
