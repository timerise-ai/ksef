# ksef

[![Agent Skills](https://img.shields.io/badge/Agent_Skills-open_format-059669)](https://agentskills.io)
[![skills.sh](https://img.shields.io/badge/skills.sh-npx_skills_add-059669)](https://www.skills.sh)
[![Claude Code](https://img.shields.io/badge/Claude_Code-compatible-059669)](https://docs.claude.com/en/docs/claude-code/skills)
[![Codex CLI](https://img.shields.io/badge/Codex_CLI-compatible-059669)](https://developers.openai.com/codex/skills)
[![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-compatible-059669)](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md)

An [Agent Skill](https://agentskills.io) that teaches an agent to build **KSeF API 2.0** integrations (Krajowy
System e-Faktur, Poland's national e-invoicing system) in a **Next.js App Router** app on Vercel: KSeF-token
auth, AES-256-CBC/RSA-OAEP invoice encryption, interactive and batch sending, UPO receipts, incremental
purchase-invoice sync, KOD I/KOD II QR codes and offline modes, certificates and permissions, and the
cron-polling architecture serverless forces on you. Official SDKs exist for C# and Java only; this is the
TypeScript equivalent.

A KSeF integration has one hard requirement: **an invoice that leaves your app is a legally binding tax
document**, filed under a taxpayer's NIP, and nothing in the API checks that the taxpayer is yours. This skill
was written by the engineer who has shipped this integration, starting from the Ministry of Finance's own API
2.0 specification and corrected against what integrating it taught us. The references are written so that
requirement holds by construction: the seller NIP is compared to the authenticating context before every
send, the raw ciphertext is uploaded with the IV carried once in the session metadata, a `440` duplicate
resolves to its UPO in the session that accepted it, and every rejection is stored with its description and
details, not only its code. The examples in `assets/examples/` type-check under `--strict`;
[CHANGELOG.md](CHANGELOG.md) is the record.

## Install

One command, via the [skills.sh](https://www.skills.sh) CLI, which installs the skill into every
skills-compatible agent it detects, including Claude Code, Codex CLI and Gemini CLI:

```bash
npx skills add timerise-ai/ksef
```

Name the agents instead with `-a`, for example `npx skills add timerise-ai/ksef -a claude-code -a codex`.

Or clone it yourself. Nothing here is Claude-specific: the skill is a plain [Agent
Skills](https://agentskills.io) folder, `SKILL.md` plus markdown references and runnable examples with no file
that calls a model, so cloning it into an agent's skills directory is all an install is. For Claude Code:

```bash
git clone https://github.com/timerise-ai/ksef.git ~/.claude/skills/ksef
```

To scope it to a single project instead, clone it into that project's `.claude/skills/` directory. For another
agent, clone into that agent's skills directory, or symlink the Claude Code copy so one `git pull` updates
every agent:

```bash
mkdir -p ~/.agents/skills
ln -s ~/.claude/skills/ksef ~/.agents/skills/ksef
```

Update the skill with `git pull` in its directory. Releases are listed in [`CHANGELOG.md`](CHANGELOG.md), with
git tags as the version of record. The [skills index](https://github.com/timerise-ai/skills) lists the other
Timerise Skills and how to install them all at once.

## Activation

The skill activates automatically when a task matches its description: sending, receiving, querying or
syncing structured invoices (faktura ustrukturyzowana, FA(3) XML) via `api.ksef.mf.gov.pl`; KSeF auth
(challenge, XAdES, KSeF token, accessToken/refreshToken); invoice encryption, UPO receipts, QR codes,
interactive or batch sessions, offline modes, KSeF certificates, tokens or permissions; or the vocabulary
itself, such as KSeF, e-faktura, Polish e-invoicing, UPO, FA(3) and `ksef.mf.gov.pl`. Invoke it explicitly
with `/ksef` in Claude Code, `$ksef` in Codex CLI, or from `/skills` in Gemini CLI.

Each host matches a task against the description its own way, so invoke the skill explicitly on a first run
rather than assuming it fired. Only `SKILL.md` is read up front; the `references/` files load on demand, so
the skill stays cheap in context until a topic is actually needed.

## What's inside

| File | Contents |
|---|---|
| `SKILL.md` | Entry point: critical facts, environments, quick start, and the reference directory |
| `references/architecture-and-vercel.md` | Start here for greenfield: system model, env vars, Postgres DDL, cron polling, multi-tenancy, Vercel function limits, go-live checklist |
| `references/crypto-and-client.md` | The `node:crypto` primitives for AES-256-CBC, RSA-OAEP key wrapping and hashes, and the typed fetch client |
| `references/auth.md` | Challenge flow, KSeF-token auth, access/refresh token lifecycle, the bootstrap-once XAdES step |
| `references/sending-interactive.md` | Online sessions, invoice status codes, `description`/`details`/`extensions`, duplicates, UPO, pre-send NIP validation |
| `references/sending-batch.md` | Sesja wsadowa (batch session): the ZIP/tar.gz pipeline, part splitting, part uploads |
| `references/receiving-and-sync.md` | Metadata queries, export packages, high-water-mark incremental sync |
| `references/qr-codes-and-offline.md` | KOD I / KOD II, verification links, offline24 and awaryjny modes, technical corrections |
| `references/certificates-tokens-permissions.md` | KSeF tokens, CSR enrollment, certificate types, the permissions model |
| `references/errors-limits-and-testing.md` | Rate limits, error codes, troubleshooting, and the TEST-environment bootstrap |
| `assets/examples/*.ts` | Six runnable scripts mirroring the reference code (`npx tsx <script>`): `crypto.ts`, `ksef-client.ts`, `auth-ksef-token.ts`, `send-invoice-online.ts`, `poll-session-status.ts`, `qr-codes.ts` |
| `CHANGELOG.md` | The release history and the record of what each release changed and why, which is this skill's provenance |

The backend seam is the state schema, not an adapter interface. KSeF has no webhooks, so **every operation is
resumable from your database**: `architecture-and-vercel.md` gives the Postgres DDL sketch for credentials,
sessions, invoices, sync checkpoints and in-flight exports that the cron routes in every other reference read
and write. Neon or Supabase Postgres is what the sketch is written against; any store that can hold those five
tables works, and the columns are what matter, not the vendor. Everything KSeF-facing lives in `lib/ksef/`
behind `import 'server-only'`; your app's auth, tenancy, invoice model and UI stay yours, joined to the module
at one point, the per-tenant credential loader, which must fail closed rather than fall back to an env-var
token.

## The six non-negotiables

`SKILL.md` opens with eight critical facts. These are the ones an integration does not hold without:

1. **Upload raw ciphertext and never prepend the IV.** It is transmitted once in
   `encryption.initializationVector`. The MF docs say otherwise; every official client contradicts them, and
   KSeF reports a prefixed IV as invoice status `430` on the invoice size. `assets/examples/crypto.ts` is the
   reference implementation.
2. **The seller NIP must equal the authenticating context NIP.** Verify before every send, and never fall back
   to a shared env-var token in a multi-tenant app. Either mistake files invoices under the wrong taxpayer.
3. **No XAdES in the runtime path.** Authenticate out-of-band once, mint a KSeF token, and authenticate with
   pure `node:crypto` from then on.
4. **No webhooks: submit, then poll.** State lives in your database between cron invocations; sync KSeF into
   it rather than proxying user clicks into tight hourly rate limits (e.g. 20 metadata queries/hour, per
   context and IP).
5. **Everything is server-only.** Tokens, session AES keys and invoice XML never reach a client component,
   and credentials are encrypted at rest.
6. **Persist `status.description` and `status.details`, not just the code.** `430` is an umbrella over schema,
   hash, size and encoding faults; only the text says which. And FA(3) is the only FA schema DEMO and PRD
   accept, while FA(2) works on TEST only.

Everything else is the host app's: auth, tenancy, invoice model, database vendor, UI.

## Not this

| Not this | Use instead |
|---|---|
| Other countries' e-invoicing systems, such as ViDA, PEPPOL-only flows outside KSeF, Italian SdI | That system's own API and documentation |
| Polish tax or legal advice | A tax advisor; this skill covers the API, not interpretations of the VAT Act |
| KSeF 1.0 (the SessionToken/InitSigned XML API) | The Ministry's 1.0 documentation; this skill covers API 2.0 only |

## Requirements

- A Next.js App Router app on Vercel, since the patterns assume serverless functions, Vercel Cron, and a
  database (Neon/Supabase Postgres or equivalent)
- A KSeF token for the target environment; the one-time bootstrap on TEST and production is documented in
  `references/errors-limits-and-testing.md`
- Env vars `KSEF_BASE_URL`, `KSEF_KSEF_TOKEN`, `KSEF_CONTEXT_NIP` to get started, plus
  `KSEF_CREDENTIALS_ENCRYPTION_KEY` and `CRON_SECRET` once credentials live in the database and crons run, all
  of them documented in `references/architecture-and-vercel.md`

## Security

- Every example reads credentials from environment variables: no secrets in code blocks, ever, and the agent
  is instructed never to log, echo or embed a credential value.
- Invoice XML received from KSeF is untrusted third-party content: never executed, never interpolated into a
  command or query.
- All KSeF logic stays server-only (`import 'server-only'`), with tokens and session keys encrypted at rest.

## Contributing

Issues and pull requests are welcome here. Pure markdown plus standalone TypeScript examples, with no build,
tests or dependencies in this repository. The examples are type-checked with `npx tsc --noEmit --strict` after
`npm i -D typescript @types/node` in `assets/examples`, and the pure-crypto helpers run with `npx tsx`. Claims
in this skill are meant to be verifiable: if you change a factual claim, say how you verified it, whether
against the [official docs and OpenAPI spec](https://github.com/CIRFMF/ksef-api), never from memory.

Adding, removing or renaming a file in `references/` means updating the quick start and the reference
directory table in `SKILL.md`, the file table above, and any relative cross-links. Every odd-looking part of
the templates is there for a documented reason, and `CHANGELOG.md` is the ledger that must stay truthful:
read it before simplifying anything, and add an entry for anything you change. Commits follow Conventional
Commits and releases follow [STANDARD.md](https://github.com/timerise-ai/skills/blob/main/STANDARD.md) in the
index; `CLAUDE.md` carries the full editing conventions.
## Part of the Timerise Skills

This is one of the [Timerise Skills](https://github.com/timerise-ai/skills): modules for **Next.js App
Router** apps written by our own senior engineers from the modules they have shipped, not synthetic, each
published as its own repository and indexed there. They share one layout, so an agent that has read one knows
how to read the next: a `SKILL.md` entry point, `references/` loaded on demand, and a seam contract carrying
the module's non-negotiables.

## Links

- [Official KSeF API docs (CIRFMF/ksef-api)](https://github.com/CIRFMF/ksef-api)
- [KSeF API Swagger (TEST)](https://api-test.ksef.mf.gov.pl/docs/v2)
- [Official C# client](https://github.com/CIRFMF/ksef-client-csharp) and [Official Java
  client](https://github.com/CIRFMF/ksef-client-java)
- [KSeF at podatki.gov.pl](https://www.podatki.gov.pl/ksef/)

## Author

Built and maintained by [Timerise](https://timerise.ai).

## License

MIT. See [LICENSE](LICENSE).