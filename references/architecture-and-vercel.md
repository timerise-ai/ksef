# Architecture: KSeF integrations on Vercel

Read this first for greenfield work — it encodes the decisions that are
expensive to reverse.

## The KSeF system model

Four properties drive every design choice:

1. **Asynchronous, pull-only.** KSeF has **no webhooks**. Sending, exports,
   certificate enrollment, permission grants — everything is submit → poll.
   Your app needs a scheduler (Vercel Cron) and durable state; nothing
   "completes" inside one request.
2. **Envelope encryption everywhere.** Every invoice and package is
   AES-encrypted by *you*, with keys wrapped for the MF — on TEST too. There
   is no "simple mode" ([crypto-and-client.md](crypto-and-client.md)).
3. **Rate limits are per (context, IP) and tight hourly** (e.g. 20 metadata
   queries/hour). KSeF is a system of record you *synchronize with*, not an
   API you proxy user traffic to
   ([errors-limits-and-testing.md](errors-limits-and-testing.md)).
4. **Everything is secret-bearing.** KSeF tokens, access tokens, session AES
   keys, certificate private keys — all server-only, all encrypted at rest.

## Environments

| Env | API base (append `/v2`) | QR host | Notes |
|---|---|---|---|
| TEST | `https://api-test.ksef.mf.gov.pl` | `qr-test.ksef.mf.gov.pl` | Self-signed certs OK; FA(2)+FA(3); shared data — random NIPs only; limits 10× PRD |
| DEMO | `https://api-demo.ksef.mf.gov.pl` | `qr-demo.ksef.mf.gov.pl` | Production config & limits; final validation |
| PRD | `https://api.ksef.mf.gov.pl` | `qr.ksef.mf.gov.pl` | Legally binding invoices |

Swagger UI per environment: `{base}/docs/v2`. TEST/DEMO maintenance window
16:00–18:00 daily. Never send real invoices to TEST/DEMO.

## Reference architecture

```
Browser ──► Next.js (Vercel)
             ├─ Server Actions / Route Handlers        ── user-triggered work
             │    └─ lib/ksef/* (server-only)          ── crypto, client, auth
             ├─ app/api/cron/ksef-send    (Vercel Cron)── batch send unsent invoices
             ├─ app/api/cron/ksef-status  (Vercel Cron)── finish pending sends, fetch UPOs
             ├─ app/api/cron/ksef-sync    (Vercel Cron)── incremental purchase-invoice sync
             │
             ├─ Postgres (Neon/Supabase) ── tokens, sessions, invoice state, HWM checkpoints, UPOs
             ├─ Vercel Blob              ── large user uploads, archived XML/UPO files (optional)
             └─ outbound HTTPS ──► api{-test|-demo}.ksef.mf.gov.pl/v2
```

Rules:

- All KSeF code lives in `lib/ksef/` with `import 'server-only'` — an accessToken
  or invoice XML in a client component is a compliance incident.
- Every KSeF operation is resumable from the DB: persist reference numbers
  *before* acting on them; assume any invocation can die mid-flight.
- User-facing reads (invoice lists, statuses, downloads) hit **your DB**,
  never KSeF directly.

## Environment variables

```bash
KSEF_BASE_URL=https://api-test.ksef.mf.gov.pl/v2   # switch per environment
KSEF_CONTEXT_NIP=1111111111
KSEF_KSEF_TOKEN=...           # the runtime credential — see auth.md; secret
KSEF_CREDENTIALS_ENCRYPTION_KEY=...  # 32-byte key (base64) for at-rest encryption of tokens/keys in DB
CRON_SECRET=...               # protects cron routes; Vercel sends it automatically to scheduled invocations
```

Never prefix any of these with `NEXT_PUBLIC_`. Multi-tenant apps store
per-tenant KSeF tokens in the database (encrypted with
`KSEF_CREDENTIALS_ENCRYPTION_KEY` via `node:crypto` AES-GCM), not in env vars.

> **Quote values containing `|` in `.env` files.** KSeF tokens may contain
> pipes and other shell metacharacters. Next.js and bun parse `.env` correctly,
> but `source .env.local` in bash/zsh silently truncates an unquoted value at
> the first `|` — you then authenticate with a partial token and get a
> confusing `450`. Always write `KSEF_KSEF_TOKEN="..."`.

### The env-fallback trap in multi-tenant apps

A credential loader that falls back to `process.env.KSEF_KSEF_TOKEN` when a
tenant has no row is a **cross-tenant invoicing incident**, not a convenience:
every tenant without configured KSeF credentials would silently issue invoices
under the env token's NIP — legally binding documents filed against the wrong
taxpayer, discovered by the tax office rather than by you. Fail closed:

```typescript
// lib/ksef/credentials.ts
import 'server-only';

export async function loadKsefCredentials(tenantId: string) {
  const row = await db.ksefCredentials.findByTenant(tenantId);
  if (row) return decryptCredentials(row);

  // Dev-only convenience: never on production, never against PRD.
  const isProd = process.env.NODE_ENV === 'production';
  const isPrdApi = !/api-(test|demo)\./.test(process.env.KSEF_BASE_URL ?? '');
  if (isProd || isPrdApi) return null;

  const token = process.env.KSEF_KSEF_TOKEN;
  const contextNip = process.env.KSEF_CONTEXT_NIP;
  return token && contextNip ? { ksefToken: token, contextNip } : null;
}
```

Return `null` (and surface "KSeF not configured for this tenant") rather than
borrowing someone else's identity.

## State schema (Postgres sketch)

```sql
create table ksef_credentials (          -- one row per tenant/context
  tenant_id        text primary key,
  context_nip      text not null,
  ksef_token_enc   bytea not null,       -- AES-GCM encrypted at rest
  access_token_enc bytea,
  access_token_exp timestamptz,
  refresh_token_enc bytea,
  refresh_token_exp timestamptz
);

create table ksef_sessions (             -- open online/batch sessions
  reference_number text primary key,
  tenant_id        text not null references ksef_credentials,
  kind             text not null check (kind in ('online','batch')),
  cipher_key_enc   bytea not null,       -- session AES key, encrypted at rest
  iv               bytea not null,
  valid_until      timestamptz not null,
  closed_at        timestamptz
);

create table ksef_invoices (
  id               text primary key,     -- your internal id
  tenant_id        text not null,
  direction        text not null check (direction in ('outbound','inbound')),
  status           text not null,        -- created|sent|accepted|rejected|upo_stored
  session_ref      text,
  invoice_ref      text,                 -- KSeF per-session reference
  ksef_number      text unique,          -- dedupe key for inbound sync
  status_code      int,
  xml              bytea,                -- or a Blob URL
  upo_xml          bytea,
  offline_mode     boolean not null default false,
  acquisition_date timestamptz,
  updated_at       timestamptz not null default now()
);

create table ksef_sync_checkpoints (     -- HWM per (tenant, subjectType)
  tenant_id      text not null,
  subject_type   text not null,          -- Subject1|Subject2|Subject3|SubjectAuthorized
  last_synced_to timestamptz not null,
  last_run_at    timestamptz,
  primary key (tenant_id, subject_type)
);

create table ksef_exports (              -- in-flight export operations
  id               serial primary key,
  tenant_id        text not null,
  reference_number text not null,
  checkpoint_tenant text not null,
  checkpoint_subject text not null,
  cipher_key_enc   bytea not null,
  iv               bytea not null,       -- needed to decrypt the package parts
  created_at       timestamptz not null default now(),
  completed_at     timestamptz
);
```

## Vercel constraints and how to work with them

| Constraint | Consequence for KSeF |
|---|---|
| Function duration (`maxDuration`; Fluid compute allows up to ~800 s at the time of writing — check current Vercel docs) | Never wait for KSeF async results in a user request. Short-poll ≤ ~20 s in `after()`, persist, let cron finish. Set `export const maxDuration = 300` (or your plan's max) on cron routes doing batch/export work. |
| Request body limit (~4.5 MB) | Affects **inbound** uploads to your app only (KSeF calls are outbound). Big user uploads (batch XML sets) go through Vercel Blob client uploads. |
| No shared memory between invocations | Tokens, session keys, checkpoints live in the DB — see schema above. In-process caches (MF public keys) are best-effort warm-instance optimizations only. |
| Egress IPs vary | Rate limits are per (context, IP) — variance is tolerated, but don't *design* IP rotation to dodge limits (flagged as abuse). Skip `authorizationPolicy` IP allowlists. |
| Cron minimum granularity 1/min | Fine — KSeF pacing wants ≥ 15 min sync intervals anyway. |

`after()` (from `next/server`) runs work after the response is sent within the
same invocation; `waitUntil` from `@vercel/functions` is the lower-level
equivalent. Both still count against function duration.

### Cron configuration

```json
// vercel.json
{
  "crons": [
    { "path": "/api/cron/ksef-send",   "schedule": "*/5 * * * *" },
    { "path": "/api/cron/ksef-status", "schedule": "* * * * *" },
    { "path": "/api/cron/ksef-sync",   "schedule": "*/5 * * * *" }
  ]
}
```

- Verify `Authorization: Bearer ${CRON_SECRET}` in each cron route.
- Make every tick **idempotent**: claim work with `UPDATE ... WHERE status = ...
  RETURNING`, tolerate re-processing, upsert on `ksef_number`.
- The 5-minute crons dispatch work that is *due* — per-checkpoint pacing
  (≥ 15 min) and rate-limit budgeting live in queries, not in the schedule.
- `ksef-status` (every minute) is cheap: it only runs when there are pending
  sends/UPOs, and per-invoice status polling has generous limits (30/s).

Workload split:

- **ksef-send**: collect `status = 'created'` outbound invoices → one batch
  session (or interactive sends at trivial volume) → mark `sent`
  ([sending-batch.md](sending-batch.md), [sending-interactive.md](sending-interactive.md)).
- **ksef-status**: for `sent` invoices, poll status → `accepted`/`rejected`,
  store `ksef_number`, download UPO → `upo_stored`; close finished sessions.
- **ksef-sync**: two-tick export harvester for inbound invoices
  ([receiving-and-sync.md](receiving-and-sync.md)).

For long chains with retries and human-visible progress, Vercel's Workflow
DevKit (durable `"use workflow"` functions) is a natural upgrade from raw
crons — the KSeF call sequence stays identical.

## Multi-tenancy

- One KSeF **context** per tenant NIP; one KSeF token per tenant, minted by
  the tenant's owner/admin and entered into your app (encrypted immediately).
- Rate limits are counted per context — tenants don't share quota, but your
  cron fan-out should still stagger tenants to smooth your own egress.
- Keep per-tenant isolation strict: session AES keys and tokens must never
  cross tenant boundaries; scope every query by `tenant_id`.
- **Bind the invoice's seller NIP to the authenticating context.** The seller
  in `Podmiot1` typically comes from your tenant profile while the token
  authenticates `ksef_credentials.context_nip` — two tables with nothing
  linking them. Compare them (digits only) both when saving KSeF settings *and*
  again immediately before every send, because the tenant profile can be edited
  afterwards. Implementation in
  [sending-interactive.md](sending-interactive.md#pre-send-validation).
- An accounting-office product (one operator, many client companies) can
  alternatively authenticate in each client's context via **indirect grants**
  — see [certificates-tokens-permissions.md](certificates-tokens-permissions.md).

## Go-live checklist

- [ ] FA(3) XML generation validated against the XSD (TEST accepts FA(2), PRD will not)
- [ ] Bootstrap: production KSeF token minted by the customer's owner account, stored encrypted
- [ ] `KSEF_BASE_URL` switched; QR host switched to `qr.ksef.mf.gov.pl` (QR links embed the environment!)
- [ ] Duplicate handling (invoice status 440) tested end to end — including
      fetching the UPO from the *original* session — and the technical-correction path
- [ ] Seller-NIP ↔ context-NIP guard active at settings-save and at send time
- [ ] No env-var credential fallback reachable in production (multi-tenant apps)
- [ ] Rejection diagnostics persisted: `status.code` **and** `status.details`
- [ ] Rate-limit budget reviewed against expected volume; batch mode for anything > single-invoice trickle
- [ ] UPOs persisted and retrievable per invoice; offline-mode QR II works if offline invoicing is offered
- [ ] Statutory dates verified against current law (mandate phases in from 1 Feb 2026 — podatki.gov.pl/ksef)

## Sources

- [Environments (srodowiska.md)](https://github.com/CIRFMF/ksef-api/blob/main/srodowiska.md)
- [API limits & integration guidance (limity-api.md)](https://github.com/CIRFMF/ksef-api/blob/main/limity/limity-api.md)
- [Key changes in KSeF 2.0 (przeglad-kluczowych-zmian-ksef-api-2-0.md)](https://github.com/CIRFMF/ksef-api/blob/main/przeglad-kluczowych-zmian-ksef-api-2-0.md)
- Vercel docs: Functions duration & Fluid compute, Cron Jobs, Blob client uploads
