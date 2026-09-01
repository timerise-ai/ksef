# Rate limits, error handling, and the TEST environment

## Rate-limit model

- Limits are counted per **(context, client IP)** pair — the same NIP context
  used from two IPs gets two independent counters.
- Three **sliding windows** run in parallel per endpoint: req/s (last second),
  req/min (last 60 s), req/h (last 60 min). None of them resets at :00; the
  first threshold crossed triggers the block.
- Exceeding a limit returns **HTTP 429** with a `Retry-After` header
  (seconds). The block duration is **dynamic and escalates** with repeated
  violations — always honor `Retry-After`
  (see `ksefFetch` in [crypto-and-client.md](crypto-and-client.md)).
- **Do not try to out-engineer the limits with IP rotation.** The MF
  explicitly monitors "systematic parallel use of many IPs within one
  context" as a potential abuse/security incident. Vercel functions having
  naturally varying egress IPs is fine; deliberately spreading load across
  IPs to multiply quota is not.
- Higher download limits apply nightly 20:00–06:00 (exact values tuned
  operationally).
- Current limits are dynamic and readable at runtime: `GET /rate-limits`, plus
  structural limits per context/subject at `GET /limits/context` and
  `GET /limits/subject`. Treat the numbers below as a **snapshot** (docs dated
  late 2025).

### Snapshot: request limits (PRD; TEST defaults are 10×, DEMO = PRD)

| Endpoint | req/s | req/min | req/h |
|---|---|---|---|
| `POST /invoices/query/metadata` | 8 | 16 | 20 |
| `POST /invoices/exports` | 8 | 16 | 20 |
| `GET /invoices/exports/{ref}` | 10 | 60 | 600 |
| `GET /invoices/ksef/{ksefNumber}` | 8 | 16 | 64 |
| `POST /sessions/online` | 10 | 30 | 120 |
| `POST .../online/{ref}/invoices` | 10 | 30 | 180 |
| `POST .../online/{ref}/close` | 10 | 30 | 120 |
| `POST /sessions/batch` (and close) | 10 | 20 | 60 |
| Batch **part uploads** | not rate-limited — parallelize |
| `GET /sessions/{ref}/invoices/{invRef}` | 30 | 120 | 1200 |
| `GET /sessions` | 5 | 10 | 60 |
| `GET /sessions/{ref}/invoices` (+ `/failed`) | 10 | 20 | 200 |
| other `GET /sessions/*` | 10 | 120 | 1200 |
| **everything else** `/*` | 10 | 30 | 120 |
| `POST /auth/challenge` (public) | 60/s per IP |

Note the hourly caps that surprise people: **20/h** on metadata queries and
export starts, **64/h** on single-invoice downloads. This is why the
architecture must sync to a local DB instead of proxying user clicks to KSeF
([receiving-and-sync.md](receiving-and-sync.md)).

### Structural limits (snapshot)

| Limit | Value |
|---|---|
| Invoice XML | 1 MB (3 MB with attachments) |
| Invoices per session | 10 000 |
| Batch package | ≤ 5 GB plaintext, ≤ 50 parts, part ≤ 100 MB before encryption |
| Metadata query result | 10 000 rows (then `isTruncated`) |
| Export package | ≤ 10 000 invoices (then `isTruncated`) |
| Sync cadence | ≥ 15 min per (context, subjectType) |

## Error handling

Error envelope (JSON endpoints): `{ "status": { "code", "description", "details": [] } }`
or an `exceptionDetailList` with `exceptionCode`s. Optionally request RFC 9457
problem-details format with the header `X-Error-Format: problem-details`.
Watch for the `X-System-Warning` response header — MF uses it for deprecation
and operational announcements.

Codes worth explicit handling:

| Code | Where | Meaning → action |
|---|---|---|
| HTTP 429 | anywhere | Rate limited → honor `Retry-After`, back off, escalations are penal |
| HTTP 400 on `/auth/token/redeem` | auth | Redeem is one-time → you lost the race or retried; re-authenticate |
| 21470 | encryption-dependent calls | Stale/withdrawn MF public key → re-fetch `/security/public-key-certificates`, rebuild EncryptionInfo, retry once |
| 440 (invoice status) | send | Duplicate (NIP + RodzajFaktury + P_2) → read `originalKsefNumber` from extensions; don't blind-retry |
| 415 (auth status) | auth | Subject has no permission in the context → fix grants, not code |
| 450 / 460 (auth status) | auth | Bad token / certificate problem → **read `status.description` before acting**: "token cannot be used in context {NIP}" means the token belongs to a different context (fix the NIP), while encryption/format problems point at the `token\|timestampMs` payload, and only revocation calls for a new token |
| 410 Gone | async status endpoints | Status retention elapsed → treat as "look up result in your own DB" |
| 420 (export status) | exports | `from` beyond current HWM → nothing new yet; retry later, not immediately |
| 550 | any async op | Cancelled by system → safe to retry the whole operation |

## Field-tested pitfalls

Symptoms observed in real integrations, with the cause that actually produced
them. Each one presents as a different problem than it is — which is why the
first move on any rejection is to read `status.description` and
`status.details` rather than to interpret the code.

| Symptom | Actual cause | Fix |
|---|---|---|
| `430` "Rozmiar faktury nie zgadza się z zadeklarowaną wartością" (size mismatch), sizes verified correct | IV prepended to the ciphertext, so KSeF decrypts 16 bytes too many | Send raw ciphertext; IV only in `encryption.initializationVector` ([crypto-and-client.md](crypto-and-client.md#3-aes-256-cbc-document-encryption)) |
| `430` on schema validation, NIP "looks right" | A display formatter (`123-456-32-18`) reached the XML; `TNrNIP` is 10 bare digits | Build XML from raw values; validate with `xmllint --schema` in CI ([sending-interactive.md](sending-interactive.md#pre-send-validation)) |
| Every KSeF number rejected by your validator, including ones KSeF issued | CRC-8 computed over the string *including* the separating hyphen | Checksum covers the 32-char data part only ([sending-interactive.md](sending-interactive.md#ksef-number)) |
| Duplicate path never triggers; `originalKsefNumber` always `undefined` | `status.extensions` read as `[{key, value}]` — it is a string-keyed object | `status.extensions?.originalKsefNumber` |
| Invoice stored as fiscalised with an empty UPO | UPO fetched from the *current* session after a `440`, inside `catch(() => null)` | Fetch from the original session; never swallow the failure ([sending-interactive.md](sending-interactive.md#4-retrieve-upo-urzędowe-poświadczenie-odbioru)) |
| Auth `450` "token invalid or inactive" (your wording), token freshly minted | KSeF said *"Token nie może być użyty w kontekście {NIP}"* — the token belongs to another context | Fix the context NIP; surface KSeF's own description ([auth.md](auth.md)) |
| Export package unzips only when it has one part | Parts are a **binary** split — each part is not an archive | Decrypt all parts, concatenate, then unzip ([receiving-and-sync.md](receiving-and-sync.md)) |
| Works in the app, fails when run from a shell script | Unquoted `.env` value containing `\|` truncated by `source` | Quote env values |
| Invoices "pending" forever while the cron reports `{"processed":0}` | Rows marked pending with no corresponding queue/job row — the cron is healthy and has nothing to claim | Make enqueue atomic with the status write; alert on pending-without-job |

## TEST environment rules

- Base URL `https://api-test.ksef.mf.gov.pl` (docs & Swagger at `/docs/v2`).
- **Self-signed certificates are accepted** — the only environment where you
  can bootstrap without a qualified signature.
- Data is **shared between integrators and not isolated**: use randomly
  generated NIPs, never real company data or production invoices.
- Accepts FA(2) and FA(3); runs release-candidate versions ahead of PRD.
- Maintenance window (TEST and DEMO): 16:00–18:00 daily.
- Default rate limits are 10× production; simulate production limits with
  `POST /testdata/rate-limits/production`, set custom ones with
  `POST /testdata/rate-limits`, reset with `DELETE /testdata/rate-limits`.

### /testdata/* helpers (TEST only)

| Endpoint | Purpose |
|---|---|
| `POST /testdata/subject` / `.../subject/remove` | Create/remove a test entity (company, VAT group, bailiff, court enforcement authority) |
| `POST /testdata/person` / `.../person/remove` | Create/remove a test person with permissions (e.g. owner by PESEL/NIP) |
| `POST /testdata/permissions` / `.../permissions/revoke` | Grant/revoke arbitrary permissions to set up scenarios |
| `POST /testdata/attachment` / `.../attachment/revoke` | Enable/disable invoice-attachment consent for a NIP |
| `POST /testdata/context/block` / `.../unblock` | Simulate a blocked context |
| `POST /testdata/limits/context/session`, `.../limits/subject/certificate` | Adjust structural limits for tests |

These let you script full integration-test setups (e.g. a VAT group with a
sub-unit, an accounting office with indirect grants) without any paperwork.

## Bootstrap walkthrough on TEST (zero to KSeF token)

Goal: obtain the KSeF token your Next.js app will use at runtime
([auth.md](auth.md)). One-time, ~15 minutes:

1. Install the .NET 10 SDK, clone the official C# client:

   ```bash
   git clone https://github.com/CIRFMF/ksef-client-csharp.git
   cd ksef-client-csharp/KSeF.Client.Tests.CertTestApp
   dotnet run --framework net10.0
   ```

   The `CertTestApp` demo generates a **self-signed test certificate** for a
   random NIP (flags let you pin a NIP and write artifacts to files), builds
   the `AuthTokenRequest`, signs it XAdES, authenticates against TEST and
   prints the resulting `accessToken`/`refreshToken`.
2. With that `accessToken`, mint a KSeF token for your app:

   ```bash
   curl -s -X POST "https://api-test.ksef.mf.gov.pl/v2/tokens" \
     -H "Authorization: Bearer ${KSEF_BOOTSTRAP_ACCESS_TOKEN:?}" \
     -H "Content-Type: application/json" \
     -d '{"permissions":["InvoiceRead","InvoiceWrite"],"description":"nextjs dev"}'
   ```

3. Save the returned `token` value as `KSEF_KSEF_TOKEN` (Vercel env var /
   `.env.local`), the NIP as `KSEF_CONTEXT_NIP`, and
   `KSEF_BASE_URL=https://api-test.ksef.mf.gov.pl/v2`. From here the app never
   needs XAdES again.

   **Quote the token in `.env.local`** (`KSEF_KSEF_TOKEN="..."`). Tokens can
   contain `|`; Next.js and bun parse the file correctly either way, but
   `source .env.local` in bash/zsh truncates an unquoted value at the pipe, so
   the bug only appears when you test from a shell.

   The NIP you pin here must be the NIP that appears as the seller
   (`Podmiot1`) in the invoices you will send — a mismatch fails at auth
   (`450`) or, worse, files invoices under the wrong taxpayer.

On DEMO/PRD the same step 2–3 applies, but step 1 requires a real credential:
authenticate once via the official taxpayer web app (login with Trusted
Profile / qualified signature, generate the token in its UI) or run the
XAdES flow with your qualified certificate using the official C#/Java client.

## Sources

- [API request limits (limity-api.md)](https://github.com/CIRFMF/ksef-api/blob/main/limity/limity-api.md)
- [Limits (limity.md)](https://github.com/CIRFMF/ksef-api/blob/main/limity/limity.md)
- [Environments (srodowiska.md)](https://github.com/CIRFMF/ksef-api/blob/main/srodowiska.md)
- [Test data scenarios (dane-testowe-scenariusze.md)](https://github.com/CIRFMF/ksef-api/blob/main/dane-testowe-scenariusze.md)
- [Test certificates & XAdES demo (testowe-certyfikaty-i-podpisy-xades.md)](https://github.com/CIRFMF/ksef-api/blob/main/auth/testowe-certyfikaty-i-podpisy-xades.md)
- [API changelog (api-changelog.md)](https://github.com/CIRFMF/ksef-api/blob/main/api-changelog.md)
