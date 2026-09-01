# Receiving invoices and incremental sync

KSeF's download API is designed for **synchronizing documents into your local
database**, not for serving end-user requests live. Searching, filtering and
displaying invoices must run against your own store; hitting the API per user
action is an explicitly discouraged pattern that leads to 429 blocks. The
recommended production sync interval is **≥ 15 minutes** per subject role.

Three retrieval paths:

| Path | Use for |
|---|---|
| `POST /invoices/query/metadata` | Paged metadata search — the workhorse for incremental sync |
| `GET /invoices/ksef/{ksefNumber}` | Fetch a single invoice XML (low volume only; 8/16/64 req per s/min/h) |
| `POST /invoices/exports` + status poll | Asynchronous bulk export as an encrypted package — high volume |

## Query metadata

```
POST /invoices/query/metadata?pageOffset=0&pageSize=100
```

```json
{
  "subjectType": "Subject2",
  "dateRange": {
    "dateType": "PermanentStorage",
    "from": "2026-07-01T00:00:00Z",
    "to": "2026-07-06T00:00:00Z",
    "restrictToPermanentStorageHwmDate": true
  }
}
```

- `subjectType`: your role on the invoices — `Subject1` (seller — your sales
  invoices), `Subject2` (buyer — your **purchase/cost invoices**), `Subject3`,
  `SubjectAuthorized`. A company can appear in several roles: **iterate all
  roles that matter to you**, each with its own sync state.
- `dateType`: `Issue` (P_1), `Invoicing` (accepted by KSeF), or
  `PermanentStorage` (durably written to the repository). **Use
  `PermanentStorage` for incremental sync** — it is the only date type with a
  completeness guarantee (HWM, below).
- Max window: 3 months. Dates ISO-8601; no offset ⇒ Europe/Warsaw.
- Optional filters: `ksefNumber`, `invoiceNumber`, `sellerNip`,
  `buyerIdentifier`, `amount`, `currencyCodes`, `invoicingMode`
  (online/offline), `formType` (FA/PEF/FA_RR), `invoiceTypes`, `hasAttachment`.
- Response: `{ hasMore, isTruncated, permanentStorageHwmDate, invoices[] }`,
  page cap 10 000 results per query overall (`isTruncated: true` when hit).

## The High Water Mark (HWM) sync pattern

`permanentStorageHwmDate` is the moment up to which KSeF **guarantees the data
is complete** — re-querying any range below it will never return new rows.
This makes exactly-once sync trivial:

1. Persist a **checkpoint per (context, subjectType)**: `lastSyncedTo`
   (initialize to your KSeF onboarding date).
2. Each tick, request the window `from = lastSyncedTo`, **`to` omitted**, with
   `dateType: "PermanentStorage"` and `restrictToPermanentStorageHwmDate: true`
   — KSeF then builds the largest consistent package/pages it can.
3. Advance the checkpoint:
   - result **not truncated** → `lastSyncedTo = permanentStorageHwmDate`,
   - result **truncated** (export: `package.isTruncated`, metadata:
     `isTruncated`) → `lastSyncedTo = lastPermanentStorageDate` (export) / the
     max `permanentStorageDate` you actually ingested (metadata), then loop.
4. **Deduplicate by KSeF number** on ingest (windows adjoin exactly; the
   boundary invoice can appear twice) — an `INSERT ... ON CONFLICT (ksef_number) DO NOTHING`
   or equivalent is all it takes.

## Bulk export

```
POST /invoices/exports
```

```json
{
  "encryption": { "encryptedSymmetricKey": "...", "initializationVector": "...", "publicKeyId": "..." },
  "onlyMetadata": false,
  "compressionType": "Zip",
  "filters": {
    "subjectType": "Subject2",
    "dateRange": { "dateType": "PermanentStorage", "from": "2026-07-01T00:00:00Z", "restrictToPermanentStorageHwmDate": true }
  }
}
```

The `encryption` block is **your own fresh AES key** (same construction as for
sending — [crypto-and-client.md](crypto-and-client.md)): KSeF encrypts the
result package *for you* with it. Response `201`: `{ referenceNumber }`.

Poll `GET /invoices/exports/{referenceNumber}`:

| status.code | Meaning |
|---|---|
| 100 | Export in progress |
| **200** | Done — `package` present |
| 210 | Package expired (past `packageExpirationDate`) — re-export |
| 415 | Your encryption block could not be decrypted |
| 420 | `dateRange.from` is beyond the current HWM — nothing new yet; back off and retry later |
| 500 / 550 | Unknown error / cancelled — retry |

`package` contains `invoiceCount` (≤ 10 000), `isTruncated`,
`lastPermanentStorageDate` (when truncated), `permanentStorageHwmDate`, and
`parts[]`, each with `method`, `url` (plain fetch, **no Authorization header**,
not rate-limited, expires at `expirationDate`), sizes and hashes of the
plaintext and encrypted part.

Each downloaded part is raw AES-256-CBC ciphertext with **no IV prefix** —
decrypt the whole part with `decryptDocument(part, cipherKey, iv)` using the
key and IV *you* supplied in the export request, concatenate the decrypted
parts, then unzip. The archive holds the invoice XMLs plus
**`_metadata.json`** — `{ invoices: InvoiceMetadata[] }`, the same shape as the
metadata query returns; use it for deduplication and for mapping files to KSeF
numbers.

## Two-tick Vercel cron worker

Splitting "start export" from "harvest export" keeps every invocation short:

```typescript
// app/api/cron/ksef-sync/route.ts
import 'server-only';
import { NextResponse } from 'next/server';
import { unzipSync } from 'fflate';
import { getValidAccessToken } from '@/lib/ksef/auth';
import { ksefFetch } from '@/lib/ksef/client';
import { buildEncryptionInfo, decryptDocument, generateSessionEncryption } from '@/lib/ksef/crypto';
import { getMfPublicKey } from '@/lib/ksef/public-keys';
import { db } from '@/lib/db';

export const maxDuration = 300;
const BASE = process.env.KSEF_BASE_URL!;

export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const accessToken = await getValidAccessToken('default');

  // Tick B first: harvest any finished exports.
  for (const exp of await db.pendingExports()) {
    const st = await ksefFetch<{
      status: { code: number };
      package?: {
        isTruncated: boolean;
        lastPermanentStorageDate?: string;
        permanentStorageHwmDate?: string;
        parts: Array<{ method: string; url: string }>;
      };
    }>(BASE, `/invoices/exports/${exp.referenceNumber}`, { accessToken });

    if (st.status.code === 100) continue;
    if (st.status.code !== 200 || !st.package) { await db.failExport(exp.id, st.status.code); continue; }

    // Parts are a BINARY split of one archive: decrypt each, concatenate, then
    // unzip once. Unzipping a single part fails unless the package has exactly one.
    const decrypted: Buffer[] = [];
    for (const part of st.package.parts) {
      const res = await fetch(part.url, { method: part.method }); // no auth header
      const encrypted = Buffer.from(await res.arrayBuffer());
      decrypted.push(decryptDocument(encrypted, exp.cipherKey, exp.iv));
    }
    const files = unzipSync(Buffer.concat(decrypted));
    const meta = JSON.parse(Buffer.from(files['_metadata.json']!).toString('utf8'));
    await db.upsertInvoices(meta.invoices, files); // ON CONFLICT (ksef_number) DO NOTHING
    await db.completeExport(exp.id, {
      nextFrom: st.package.isTruncated
        ? st.package.lastPermanentStorageDate!
        : st.package.permanentStorageHwmDate!,
    });
  }

  // Tick A: start a new export per (context, subjectType) checkpoint that is due.
  for (const cp of await db.dueSyncCheckpoints(/* ≥15 min since last run */)) {
    const enc = generateSessionEncryption();
    const { key, publicKeyId } = await getMfPublicKey(BASE, 'SymmetricKeyEncryption');
    const { referenceNumber } = await ksefFetch<{ referenceNumber: string }>(
      BASE, '/invoices/exports', {
        method: 'POST',
        accessToken,
        body: {
          encryption: buildEncryptionInfo(enc, key, publicKeyId),
          filters: {
            subjectType: cp.subjectType,
            dateRange: {
              dateType: 'PermanentStorage',
              from: cp.lastSyncedTo,
              restrictToPermanentStorageHwmDate: true,
            },
          },
        },
      },
    );
    // Persist BOTH halves: the IV is not carried inside the downloaded parts.
    await db.recordExport({
      referenceNumber, cipherKey: enc.cipherKey, iv: enc.iv, checkpointId: cp.id,
    });
  }

  return NextResponse.json({ ok: true });
}
```

Store `cipherKey` (and its `iv`) for pending exports encrypted at rest and
delete them once the package is ingested. Losing either makes the package
permanently undecryptable — KSeF will not re-key an export. Schedule this route every ~5 minutes in `vercel.json`; the
≥15-minute *per-checkpoint* pacing lives in `dueSyncCheckpoints`
([architecture-and-vercel.md](architecture-and-vercel.md) has the cron config
and DDL).

For **low volume** (a handful of purchase invoices a day) you can skip exports
entirely: run the metadata query on the same HWM checkpoint pattern and fetch
individual XMLs via `GET /invoices/ksef/{ksefNumber}` — but respect its tight
limits (8/s, 16/min, **64/h**) and still never serve it per user click.

## Sources

- [Downloading invoices (pobieranie-faktur.md)](https://github.com/CIRFMF/ksef-api/blob/main/pobieranie-faktur/pobieranie-faktur.md)
- [Incremental download (przyrostowe-pobieranie-faktur.md)](https://github.com/CIRFMF/ksef-api/blob/main/pobieranie-faktur/przyrostowe-pobieranie-faktur.md)
- [High Water Mark (hwm.md)](https://github.com/CIRFMF/ksef-api/blob/main/pobieranie-faktur/hwm.md)
- [API limits for downloads (limity-api.md)](https://github.com/CIRFMF/ksef-api/blob/main/limity/limity-api.md)
