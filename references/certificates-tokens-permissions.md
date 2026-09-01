# KSeF tokens, KSeF certificates, permissions

Three related credential concepts — know which one you need:

| | KSeF **token** | KSeF **certificate** | Permissions |
|---|---|---|---|
| What | Opaque secret string (≤160 chars) | X.509 cert issued by KSeF | Grants attached to subjects |
| Carries | A **frozen** permission set, bound to one context | Identity only — no permissions, no context | The actual rights |
| Used for | Runtime API auth (`/auth/ksef-token`) — the recommended serverless path | XAdES auth (`Authentication` type) or offline QR KOD II signing (`Offline` type) | Evaluated at every authentication |
| Obtained | `POST /tokens` while authenticated | CSR enrollment while XAdES-authenticated | Granted by Owner/admins via `/permissions/*` |

## KSeF tokens

- Created with `POST /tokens`:

  ```json
  { "permissions": ["InvoiceRead", "InvoiceWrite"], "description": "vercel-app production" }
  ```

  Permission enum: `InvoiceRead`, `InvoiceWrite`, `CredentialsRead`,
  `CredentialsManage`, `SubunitManage`, `EnforcementOperations`,
  `Introspection`. The set is **immutable** — changing scope means minting a
  new token. Response `202`: `{ referenceNumber, token }` — **the token value
  is shown only here**; store it immediately in your secret store.
- Tokens can only be generated in a `Nip` or `InternalId` context, and only
  when authenticated via XAdES-based methods (not via another KSeF token).
- Lifecycle states: `Pending → Active → Revoking → Revoked` (or `Failed`).
  Query with `GET /tokens?status=Active&pageSize=...` (paged via
  `x-continuation-token` header), inspect one with
  `GET /tokens/{referenceNumber}`, revoke with
  `DELETE /tokens/{referenceNumber}`.
- Treat like a password: env var / secret manager, never in git, never logged,
  never client-side. Rotate by minting a new token, deploying it, then
  revoking the old one.

Minimal mint call (run once, while authenticated — e.g. right after a
bootstrap XAdES auth on TEST):

```typescript
const { token, referenceNumber } = await ksefFetch<{ referenceNumber: string; token: string }>(
  BASE, '/tokens', {
    method: 'POST',
    accessToken,
    body: { permissions: ['InvoiceRead', 'InvoiceWrite'], description: 'nextjs-app' },
  },
);
// Save `token` to your secret store NOW — it is not retrievable later.
```

## KSeF certificates

Two types (`certificateType`), each cert is exactly one:

- **`Authentication`** — for XAdES authentication to the API. Verified
  internally (fast, no external OCSP wait on PRD) — useful as a durable
  bootstrap credential.
- **`Offline`** — exclusively for signing offline-invoice KOD II QR links
  ([qr-codes-and-offline.md](qr-codes-and-offline.md)). Cannot authenticate.

Enrollment flow (requires **XAdES-based** authentication — a KSeF-token
session cannot enroll certificates):

1. `GET /certificates/limits` — check you may still request one (limits on
   active certs and enrollments).
2. `GET /certificates/enrollments/data` — returns the exact X.500 DN
   attributes (commonName, surname, serialNumber e.g. PESEL/NIP, countryName,
   givenName, organizationName, organizationIdentifier…) derived from the
   certificate you authenticated with. **Use them verbatim in the CSR** — any
   modification gets the application rejected.
3. Generate a key pair and a **PKCS#10 CSR**, DER, Base64-encoded. Keys:
   RSA 2048 (the docs specify this exact length, not a minimum) or **EC P-256
   (recommended)**. Node's `crypto` cannot build CSRs —
   use a library such as `@peculiar/x509`:

   ```typescript
   import * as x509 from '@peculiar/x509';
   import { webcrypto } from 'node:crypto';
   x509.cryptoProvider.set(webcrypto as Crypto);

   const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
   const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
   // Build the DN string from the /certificates/enrollments/data response —
   // every attribute it returned, unchanged (example values shown):
   const dn = 'CN=Jan Kowalski, G=Jan, SN=Kowalski, 2.5.4.5=TINPL-1111111111, C=PL';
   const csr = await x509.Pkcs10CertificateRequestGenerator.create({
     name: dn,
     keys,
     signingAlgorithm: alg,
   });
   const csrDerBase64 = Buffer.from(csr.rawData).toString('base64');
   ```

4. `POST /certificates/enrollments` with
   `{ certificateName, certificateType: "Authentication" | "Offline", csr, validFrom? }`
   → `202 { referenceNumber }`.
5. Poll `GET /certificates/enrollments/{referenceNumber}` until issued, then
   fetch the certificate with `POST /certificates/retrieve` (by serial
   numbers). Keep the **private key** in your secret store — KSeF never sees
   it, and the Offline-type key is what signs KOD II links at runtime.
6. Housekeeping: `POST /certificates/query` (metadata search),
   `POST /certificates/{certificateSerialNumber}/revoke`.

Certificates are valid for a bounded period. Neither `/certificates/limits`
(quotas only) nor the enrollment status response (`requestDate`, `status`,
`certificateSerialNumber`) carries the window: read `validFrom`/`validTo` from
`POST /certificates/query`, or parse the X.509 returned by
`POST /certificates/retrieve`. Put `validTo` in your monitoring so renewal
isn't a surprise.

## Permissions model (overview)

You will meet permissions mostly through error 415 at auth ("no permissions in
context") or invoice status 410. The full model is rich; the essentials:

- **Owner**: a subject authenticating with a certificate whose NIP equals the
  context NIP — or a PESEL linked to it — is automatically the context owner:
  all invoice and administrative rights *except* `VatUeManage`, including
  granting.
- Permission kinds you can grant to persons/entities: `CredentialsManage`,
  `CredentialsRead`, `InvoiceWrite`, `InvoiceRead`, `Introspection`,
  `SubunitManage`, `EnforcementOperations`, plus entity-level authorizations
  (`SelfInvoicing`, `TaxRepresentative`, `RRInvoicing`, `PefInvoicing`).
- Grants can be **direct** (to a person/entity in your context) or
  **indirect** (an intermediary — e.g. an accounting office — receives rights
  to act for your clients); "general" indirect grants apply across all
  contexts the intermediary serves, "selective" ones per target context.
- Endpoint groups: grant via `POST /permissions/persons/grants`,
  `/permissions/entities/grants`, `/permissions/authorizations/grants`,
  `/permissions/indirect/grants`, `/permissions/subunits/grants`,
  `/permissions/eu-entities/grants`; revoke via
  `DELETE /permissions/common/grants/{permissionId}` or
  `/permissions/authorizations/grants/{permissionId}`; search via the
  `POST /permissions/query/...` family; operations are async — poll
  `GET /permissions/operations/{referenceNumber}`.
- Sizing an integration: the app's KSeF token typically needs only
  `InvoiceRead` + `InvoiceWrite`. Keep credential administration
  (`CredentialsManage`) out of the runtime token unless the product manages
  grants for users.

For the complete matrix (roles, EU entities, subunits, ZAW-FA paper path) read
the official document:
[uprawnienia.md](https://github.com/CIRFMF/ksef-api/blob/main/uprawnienia.md).

## Sources

- [KSeF tokens (tokeny-ksef.md)](https://github.com/CIRFMF/ksef-api/blob/main/tokeny-ksef.md)
- [KSeF certificates (certyfikaty-KSeF.md)](https://github.com/CIRFMF/ksef-api/blob/main/certyfikaty-KSeF.md)
- [Permissions (uprawnienia.md)](https://github.com/CIRFMF/ksef-api/blob/main/uprawnienia.md)
