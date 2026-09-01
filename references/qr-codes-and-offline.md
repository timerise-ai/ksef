# QR verification codes and offline modes

Every KSeF invoice **visualization** (PDF, printout, email attachment) must
carry QR verification code(s), generated **locally by your application**
(ISO/IEC 18004:2024):

- **online** invoice → one code, **KOD I** (verify/download the invoice in KSeF),
- **offline** invoice → two codes: **KOD I** plus **KOD II** (proves issuer
  authenticity via a KSeF certificate).

QR hosts per environment (note: *not* the API host):

| Env | QR base URL |
|---|---|
| TEST | `https://qr-test.ksef.mf.gov.pl` |
| DEMO | `https://qr-demo.ksef.mf.gov.pl` |
| PRD | `https://qr.ksef.mf.gov.pl` |

## KOD I — invoice verification link

Path segments, in order: seller NIP, issue date (`P_1` field of the XML) as
`DD-MM-YYYY`, SHA-256 of the invoice XML file in **Base64URL**:

```
https://qr-test.ksef.mf.gov.pl/invoice/1111111111/01-02-2026/{invoiceHashBase64Url}
```

where `{invoiceHashBase64Url}` is the 43-character unpadded Base64URL encoding
of the file's SHA-256 digest.

Label printed **under** the QR code:

- KSeF number — once it is assigned (online invoices, or offline invoices
  after successful submission),
- the literal text **`OFFLINE`** — for offline invoices not yet submitted (or
  online ones still awaiting a number).

The hash is over the exact XML file bytes you send/sent to KSeF — generate the
QR from the same buffer, or the link will not verify.

## KOD II — issuer certificate link (offline invoices only)

Requires an active **KSeF certificate of type `Offline`**
([certificates-tokens-permissions.md](certificates-tokens-permissions.md));
an `Authentication`-type certificate is rejected for this purpose. Path
segments: context identifier type (`Nip`/`InternalId`/`NipVatUe`/`PeppolId`),
context value, seller NIP, certificate serial number, invoice hash
(Base64URL), and a **cryptographic signature of the URL itself** (Base64URL):

```
https://{qrHost}/certificate/{ctxType}/{ctxValue}/{sellerNip}/{certSerial}/{invoiceHashB64Url}/{signatureB64Url}
```

**What exactly is signed**: the URL string **without the `https://` prefix and
without a trailing slash**, i.e. everything from the host up to and including
the invoice hash segment:

```
qr-test.ksef.mf.gov.pl/certificate/Nip/1111111111/1111111111/{certSerialHex}/{invoiceHashBase64Url}
```

Signature algorithms (choose per your certificate's key):

- **RSASSA-PSS**: SHA-256, MGF1-SHA-256, salt length **32 bytes**, key ≥ 2048 bit.
- **ECDSA P-256/SHA-256**: signature as `r ‖ s` (IEEE P1363, 64 bytes —
  recommended) or ASN.1 DER as a fallback.

Encode the signature **Base64URL** and append it as the final path segment.
Label under the code: the literal text **`CERTYFIKAT`**.

When scanned, KSeF verifies the certificate (validity, not revoked), the URL
signature, and that the certificate's subject has active rights to issue
invoices in that context for that seller NIP (covers self-invoicing, tax
representatives, VAT groups, etc.).

## TypeScript

```typescript
// lib/ksef/qr.ts
import 'server-only';
import { createPrivateKey, sign, constants, type KeyObject } from 'node:crypto';
import { sha256Base64Url } from './crypto';

export type QrHost =
  | 'https://qr-test.ksef.mf.gov.pl'
  | 'https://qr-demo.ksef.mf.gov.pl'
  | 'https://qr.ksef.mf.gov.pl';

/** P_1 (YYYY-MM-DD in the XML) → DD-MM-YYYY used in the link. */
function toLinkDate(p1IsoDate: string): string {
  const [y, m, d] = p1IsoDate.split('-');
  return `${d}-${m}-${y}`;
}

export function buildKodI(opts: {
  qrHost: QrHost;
  sellerNip: string;
  issueDateP1: string; // as in the XML, e.g. "2026-02-01"
  invoiceXml: Buffer;
}): string {
  const hash = sha256Base64Url(opts.invoiceXml);
  return `${opts.qrHost}/invoice/${opts.sellerNip}/${toLinkDate(opts.issueDateP1)}/${hash}`;
}

export function buildKodII(opts: {
  qrHost: QrHost;
  contextIdentifierType: 'Nip' | 'InternalId' | 'NipVatUe' | 'PeppolId';
  contextIdentifierValue: string;
  sellerNip: string;
  certificateSerialNumber: string;   // serial of the Offline-type KSeF certificate
  invoiceXml: Buffer;
  privateKeyPem: string;             // private key of that certificate — server-only secret
}): string {
  const hash = sha256Base64Url(opts.invoiceXml);
  const unsigned =
    `${opts.qrHost}/certificate/${opts.contextIdentifierType}/${opts.contextIdentifierValue}` +
    `/${opts.sellerNip}/${opts.certificateSerialNumber}/${hash}`;

  // Sign the URL without the protocol prefix and without a trailing slash.
  const toSign = Buffer.from(unsigned.replace(/^https:\/\//, ''), 'utf8');
  const key = createPrivateKey(opts.privateKeyPem);
  const signature = signUrl(toSign, key);

  return `${unsigned}/${signature.toString('base64url')}`;
}

function signUrl(data: Buffer, key: KeyObject): Buffer {
  if (key.asymmetricKeyType === 'ec') {
    // ECDSA P-256/SHA-256, IEEE P1363 (r‖s) — the recommended encoding.
    return sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' });
  }
  // RSASSA-PSS: SHA-256, MGF1-SHA-256, 32-byte salt.
  return sign('sha256', data, {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
}
```

Rendering the PNG (the `qrcode` npm package is a current common choice; any
ISO/IEC 18004-compliant generator works):

```typescript
import QRCode from 'qrcode';

export async function qrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, { errorCorrectionLevel: 'M', scale: 5, margin: 2 });
}
// Compose the label (KSeF number / "OFFLINE" / "CERTYFIKAT") under the image
// in your PDF/print template.
```

Verify your first KOD II manually on TEST — build the URL, open it in a
browser, and confirm KSeF reports the certificate as verified. A wrong salt
length or DER-vs-P1363 mix-up produces codes that *look* fine but fail
verification.

## Offline modes

Offline means: the invoice is **issued** electronically (valid FA(3) XML,
`P_1` = actual issue date) and delivered to the buyer, but **submitted to KSeF
later** within a statutory deadline. Submission (interactive or batch) sets
`offlineMode: true`.

| Mode | Trigger | Deadline to submit to KSeF | Legal basis |
|---|---|---|---|
| **offline24** | Taxpayer's own choice, always available | next business day after issue date | art. 106nda VAT Act |
| **offline** | System unavailability announced by MF (BIP + API) | next business day after the unavailability ends | art. 106nh VAT Act (from 1 Feb 2026) |
| **awaryjny** (emergency) | KSeF failure announced by MF | 7 business days from the end of the failure; a new announcement **resets the counter** | art. 106nf VAT Act (from 1 Feb 2026) |
| **awaria całkowita** (total failure) | Announced via mass media | no obligation to submit at all; paper/any-format invoices allowed, **no QR codes** | — |

Additional rules:

- If a failure is announced while an offline24/offline deadline is running,
  the deadline shifts to the end of that failure (max 7 business days).
- KSeF may **auto-classify** an invoice sent as online into offline mode when
  `P_1` (issue date) is earlier than the date KSeF received it — don't fight
  this; it changes which date counts as the buyer's receipt date.
- The buyer's receipt date for an offline invoice delivered outside KSeF is
  the actual delivery date; otherwise it's the KSeF-number assignment date.
- A correcting invoice may only be sent after the original has its KSeF number.
- No endpoint reports system unavailability or failure: the current state is
  announced in BIP and via the interface software only. Detect outages from
  your own call failures (see the auto-classification rules above), not by
  polling. (`GET /permissions/attachments/status` is unrelated — it reports
  whether the context may issue invoices *with attachments*.)

## Technical correction (korekta techniczna)

If an **offline** invoice is *rejected* on submission for technical reasons
(schema mismatch, size, duplicate), you cannot just resend a fixed file — the
buyer already holds a visualization whose KOD I points at the **original**
file's hash. The fix:

1. Regenerate a technically valid XML with the **same business content** (its
   SHA-256 will differ).
2. Send it in an **interactive session** with `offlineMode: true` **and**
   `hashOfCorrectedInvoice` = SHA-256 (Base64) of the original rejected file.
3. KSeF links the two: scans of the old KOD I now inform the buyer the invoice
   was technically corrected and point to the accepted document.

Constraints: interactive sessions only (though the rejected original may have
been batch-sent); content changes are **not** allowed (technical fixes only);
not applicable when rejection was about permissions; not allowed if a valid
correction was already accepted.

## Sources

- [QR codes (kody-qr.md)](https://github.com/CIRFMF/ksef-api/blob/main/kody-qr.md)
- [Offline modes (tryby-offline.md)](https://github.com/CIRFMF/ksef-api/blob/main/tryby-offline.md)
- [Automatic offline classification (automatyczne-okreslanie-trybu-offline.md)](https://github.com/CIRFMF/ksef-api/blob/main/offline/automatyczne-okreslanie-trybu-offline.md)
- [Technical correction (korekta-techniczna.md)](https://github.com/CIRFMF/ksef-api/blob/main/offline/korekta-techniczna.md)
