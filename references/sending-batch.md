# Sending invoices — batch session

Batch sessions submit many invoices as one compressed package. This is the
**recommended mode whenever more than one document is ready to send** — one
package of 100 invoices costs 2 rate-limited requests (open + close) instead of
100+ sends, and part uploads themselves are not rate-limited.

Limits: package ≤ 5 GB (plaintext), split into 1–50 binary parts of ≤ 100 MB
each **before encryption**, ≤ 10 000 invoices per session. Compression: `Zip`
(default) or `TarGz` — the docs recommend **tar.gz for large packages** (one
compression stream exploits the redundancy between similar XMLs; ZIP compresses
each file separately).

## Pipeline

```
1. Collect plain FA(3) XML files
2. Build the archive (ZIP or tar.gz)          → hash/size of the PLAINTEXT archive
3. Binary-split the archive into ≤100 MB parts (only if needed)
4. AES-256-CBC encrypt EACH part with the session key   → hash/size of each ENCRYPTED part
5. POST /sessions/batch  (declares archive + parts + encryption)
6. Upload each part to its partUploadRequests[i] URL — raw bytes, NO auth header
7. POST /sessions/batch/{ref}/close
8. Poll session/invoice status, download UPOs  → see sending-interactive.md §3–4
```

Key subtleties:

- The split is **binary** — parts are *not* standalone archives; KSeF
  concatenates the decrypted parts and then decompresses.
- `batchFile.fileHash`/`fileSize` describe the **plaintext archive**;
  `fileParts[i].fileHash`/`fileSize` describe each **encrypted** part — the
  raw ciphertext, with **no IV prefix**
  ([crypto-and-client.md](crypto-and-client.md#3-aes-256-cbc-document-encryption)).
- Every part is encrypted independently with the **same** session key and IV,
  declared once in `encryption`.
- Upload each part with exactly the `method`, `url` and `headers` returned in
  `partUploadRequests` (matched by `ordinalNumber`), raw encrypted bytes as the
  body, **without** `Authorization` — the URL embeds its own access key.
  Expected responses: `201` accepted, `400` bad data, `401` bad
  authentication, `403` upload window expired.
- Time budget: each part gets `partCount × 20 minutes` (a 2-part package
  → 40 min per part). Uploads may run in parallel — recommended.
- `offlineMode: true` at session level declares the whole package as
  offline-issued invoices.

## Request shape

```
POST /sessions/batch
```

```json
{
  "formCode": { "systemCode": "FA (3)", "schemaVersion": "1-0E", "value": "FA" },
  "batchFile": {
    "fileSize": 123456789,
    "fileHash": "SHA-256 of the plaintext archive, Base64",
    "compressionType": "TarGz",
    "fileParts": [
      { "ordinalNumber": 1, "fileSize": 104857616, "fileHash": "SHA-256 of encrypted part 1" },
      { "ordinalNumber": 2, "fileSize": 52428816,  "fileHash": "SHA-256 of encrypted part 2" }
    ]
  },
  "encryption": { "encryptedSymmetricKey": "...", "initializationVector": "...", "publicKeyId": "..." }
}
```

Response `201`: `{ referenceNumber, partUploadRequests: [{ ordinalNumber, method, url, headers }] }`.

## TypeScript implementation

Node has no built-in ZIP writer; `fflate` is a light, dependency-free current
choice (tar.gz can be produced with `tar-stream` + `node:zlib`, or keep ZIP for
simplicity at moderate volume).

```typescript
// lib/ksef/send-batch.ts
import 'server-only';
import { zipSync } from 'fflate';
import { ksefFetch } from './client';
import {
  buildEncryptionInfo, encryptDocument, fileMetadata,
  generateSessionEncryption,
} from './crypto';
import { getMfPublicKey } from './public-keys';

const MAX_PART_SIZE = 100 * 1000 * 1000; // 100 MB, before encryption

export function buildZip(invoices: Array<{ name: string; xml: Buffer }>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const inv of invoices) entries[inv.name] = inv.xml;
  return Buffer.from(zipSync(entries));
}

export function splitBuffer(buf: Buffer, maxSize = MAX_PART_SIZE): Buffer[] {
  const parts: Buffer[] = [];
  for (let off = 0; off < buf.byteLength; off += maxSize) {
    parts.push(buf.subarray(off, Math.min(off + maxSize, buf.byteLength)));
  }
  return parts;
}

export async function sendBatch(
  baseUrl: string, accessToken: string,
  invoices: Array<{ name: string; xml: Buffer }>,
): Promise<{ referenceNumber: string }> {
  const archive = buildZip(invoices);
  const archiveMeta = fileMetadata(archive);

  const enc = generateSessionEncryption();
  const encryptedParts = splitBuffer(archive).map((p) => encryptDocument(p, enc));

  const { key, publicKeyId } = await getMfPublicKey(baseUrl, 'SymmetricKeyEncryption');

  const session = await ksefFetch<{
    referenceNumber: string;
    partUploadRequests: Array<{
      ordinalNumber: number; method: string; url: string;
      headers: Record<string, string>;
    }>;
  }>(baseUrl, '/sessions/batch', {
    method: 'POST',
    accessToken,
    body: {
      formCode: { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' },
      batchFile: {
        fileSize: archiveMeta.sizeBytes,
        fileHash: archiveMeta.hashSha256Base64,
        fileParts: encryptedParts.map((p, i) => ({
          ordinalNumber: i + 1,
          ...(({ hashSha256Base64, sizeBytes }) =>
            ({ fileHash: hashSha256Base64, fileSize: sizeBytes }))(fileMetadata(p)),
        })),
      },
      encryption: buildEncryptionInfo(enc, key, publicKeyId),
    },
  });

  // Upload parts in parallel — raw bytes, headers as given, NO Authorization.
  await Promise.all(
    session.partUploadRequests.map(async (req) => {
      const part = encryptedParts[req.ordinalNumber - 1]!;
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: new Uint8Array(part),
        });
        if (res.ok) return;
        if (attempt >= 2) {
          throw new Error(`Part ${req.ordinalNumber} upload failed: HTTP ${res.status}`);
        }
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      }
    }),
  );

  await ksefFetch(baseUrl, `/sessions/batch/${session.referenceNumber}/close`, {
    method: 'POST', accessToken,
  });

  return { referenceNumber: session.referenceNumber };
}
```

## After closing

Processing is asynchronous. Batch session status codes:

| Code | Meaning |
|---|---|
| 100 | Session started |
| 150 | Processing |
| **200** | Processed successfully |
| 405 | Part verification failed (declared hash/size mismatch) |
| 415 | Symmetric key could not be decrypted |
| 420 | Invoice count limit exceeded |
| 430 | Archive decompression failed |
| 435 | Part decryption failed |
| 440 | Cancelled — upload window elapsed or no parts uploaded |
| 445 | No valid invoices in the package |

Each invoice is then verified **independently** (unlike KSeF 1.0, one bad
invoice no longer rejects the package): poll
`GET /sessions/{ref}/invoices` (paged), sweep
`GET /sessions/{ref}/invoices/failed` for rejects, and download UPOs — the
mechanics are identical to interactive sessions, see
[sending-interactive.md](sending-interactive.md) §3–5. `invoiceFileName`
in each invoice status links results back to the archive entries — name your
files after your internal invoice IDs.

## Vercel notes

- Run the whole pipeline in a background invocation (cron route or queued
  job), not in a user request. Building + encrypting a 100 MB part in memory
  is fine; multi-GB packages need Fluid compute's higher memory/duration
  settings or should be sharded into several smaller batch sessions.
- User-uploaded XML batches must get into your system past Vercel's request
  body limit (~4.5 MB) — accept uploads via Vercel Blob (client upload) and
  read them server-side; see
  [architecture-and-vercel.md](architecture-and-vercel.md).
- All KSeF-bound traffic (session open, part PUTs) is **outbound** — Vercel's
  body limit does not apply to it.
- A cadence that works well: cron every N minutes → collect unsent invoices →
  one batch session → record `sessionRef` → the status cron finishes the loop.
  The MF docs themselves suggest ~5-minute aggregation for e-commerce volume.

## Sources

- [Batch session (sesja-wsadowa.md)](https://github.com/CIRFMF/ksef-api/blob/main/sesja-wsadowa.md)
- [Session status and UPO (sesja-sprawdzenie-stanu-i-pobranie-upo.md)](https://github.com/CIRFMF/ksef-api/blob/main/faktury/sesje/sesja-sprawdzenie-stanu-i-pobranie-upo.md)
- [API request limits (limity-api.md)](https://github.com/CIRFMF/ksef-api/blob/main/limity/limity-api.md) — batch as the recommended mode
