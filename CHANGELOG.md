# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.3] - 2026-09-02

Documentation-only release. The skill itself, `SKILL.md` and `references/`, is
unchanged from 1.2.2. The repository history starts at this release.

### Changed
- README: the *Part of the Timerise Skills* footer says the modules are written by our own
  senior engineers from the modules they have shipped, in the words of the index's
  STANDARD.md section 2.

## [1.2.2] - 2026-09-02

Documentation-only release. The skill itself, `SKILL.md` and `references/`, is
unchanged from 1.2.1.

### Added
- README: badges under the title for the Agent Skills format, the skills.sh install, and
  Claude Code, Codex CLI and Gemini CLI compatibility.

### Changed
- README: the install leads with `npx skills add timerise-ai/ksef`, which installs the skill
  into every skills-compatible agent it detects, with the `-a` form for named agents; the
  Claude Code clone moves under a *Manual install* heading. Activation gets its own
  heading, and a *Not this* table points neighbouring problems to the right skill or tool.
- README: the rules section is titled *The six non-negotiables*.
- README: the skill's origin is reworded. It was written by the engineers who built the
  module it describes; the reference point for `provenance.md` is the earlier
  implementation rather than "the source"; the index is called Timerise Skills.
- README: every em-dash, arrow and en-dash in the prose is rewritten as a comma, colon,
  full stop or conjunction.

## [1.2.1] - 2026-09-01

### Changed
- README reframed as an Agent Skill rather than a Claude Code skill: the format
  is open and nothing in this repository is Claude-specific, so the install
  section now covers Codex CLI and Gemini CLI reading the same layout from
  `~/.agents/skills`, the symlink that keeps one clone current for every agent,
  and how invocation (`/ksef`, `$ksef`, `/skills`) and description-matching
  differ per host.
- `npx skills add timerise-ai/ksef` is documented again as the one-command
  install, reversing the 1.2.0 note that the move to `timerise-ai` made cloning
  the only route: the skills.sh CLI resolves a GitHub repository directly, so it
  needs no directory listing.
- README now describes the backend seam — the state schema, not an adapter
  interface — and the `lib/ksef/` boundary with the per-tenant credential loader
  that must fail closed.
- Expanded the non-negotiables and file table with facts already carried by
  `SKILL.md`: invoice status `430` as the rejection behind an IV-prefixed
  payload, the 20-metadata-queries/hour class of limit, the
  `KSEF_CREDENTIALS_ENCRYPTION_KEY` and `CRON_SECRET` env vars crons need, and
  FA(3) as the only schema DEMO and PRD accept.
- Removed the release number the README briefly carried; the version stays in
  the git tag and this file only.

## [1.2.0] - 2026-08-30

### Changed
- Moved the skill to the Timerise organisation: the repository is now
  `timerise-ai/ksef`, installed by cloning rather than `npx skills add`, with
  `SKILL.md` frontmatter `metadata.author`/`homepage` and the LICENSE copyright
  updated to match. The skill `name` in `SKILL.md` frontmatter is now `ksef`
  (was `ksef-nextjs`), so the clone directory and slash command are `ksef` —
  matching the repository name, as the other Timerise skills do. An existing
  install keeps responding to `/ksef-nextjs` until it is re-cloned.
- `SKILL.md` frontmatter is reduced to `name` and `description`, matching the
  other Timerise skills. The `metadata.version`, `author`, `homepage` and
  `license` keys are gone: the version now lives only in the git tag described
  by this file, so it cannot drift from a hand-edited copy, and authorship and
  licensing are stated in `README.md` and `LICENSE`.
- Rewrote `README.md` in the shared Timerise skills layout: what the skill is,
  install, a file table covering every reference, the non-negotiables,
  requirements, security, contributing conventions, and a link to the
  [skills index](https://github.com/timerise-ai/skills).
- Release notes moved out of the README's "Version History" section into this
  file.

## [1.1.0] - 2026-07-21

Corrections and hardening driven by a field report from a production
integration, verified against the official C#/Java clients and the live
OpenAPI spec (API 2.7.0).

### Fixed
- **Invoice encryption (send-blocking)**: the skill prepended the IV to the
  ciphertext, following a sentence in the MF docs that both official clients
  contradict. KSeF then decrypted 16 bytes too many and returned status `430`
  blaming the *invoice size* — a false trail. `encryptDocument()` now returns
  raw ciphertext; `decryptDocument()` takes the IV as an argument.
- **Export packages**: parts are a binary split, so they must be concatenated
  before unzipping (the old loop only worked for single-part packages), and the
  export's IV must be persisted alongside its key to decrypt them at all.
- **Duplicates (`440`)**: `status.extensions` is a string-keyed object, not a
  list of key/value pairs; and a duplicate's UPO lives in the *original*
  session, reachable via
  `/sessions/{originalRef}/invoices/ksef/{ksefNumber}/upo`.

### Added
- **Rejection diagnostics**: `status.description` / `status.details` are now
  documented and propagated everywhere — `430` is an umbrella over schema,
  hash, size and encoding faults, and only the text distinguishes them.
- **Multi-tenant safety**: guidance to bind the seller NIP to the
  authenticating context NIP, and to never fall back to a shared env-var token
  — either mistake files legally binding invoices under the wrong taxpayer.
- **Pre-send validation**: `TNrNIP` is 10 bare digits (display formatters
  leaking into XML are a common `430`), plus NIP checksum and XSD validation.
- A "Field-tested pitfalls" table mapping observed symptoms to real causes, and
  clearer `450` guidance (a wrong-context token is not a dead token).

## [1.0.1] - 2026-07-15

Correctness fixes found by re-verifying against the live OpenAPI spec.

### Fixed
- **KSeF number validator**: CRC-8 was computed over 33 characters (including
  the separating hyphen) instead of the specified 32, so `isValidKsefNumber`
  rejected every valid KSeF number — including the official docs' own example.
- **Error code extraction**: `ksefCode` read `exceptionDetailList` at the body
  root; it is nested under `exception`. The getter always returned `undefined`,
  making the error-21470 stale-key refresh-and-retry path unreachable. It now
  also reads the RFC 9457 `errors[].code` shape, and no longer mistakes a 429
  rate-limit body's HTTP status for a KSeF code.
- An over-length challenge example, a checksum-invalid KSeF number example, and
  the claim that `/permissions/attachments/status` reports system availability
  (it reports attachment consent).
- CSR key length (RSA 2048 exactly, not a minimum) and Owner rights (excludes
  `VatUeManage`).

### Added
- `PefInvoicing` permission and the part-upload `401` response.

## [1.0.0] - 2026-07-06

Initial release covering KSeF API 2.0, verified against the official
CIRFMF/ksef-api documentation and OpenAPI spec (API v2, mid-2026).

### Added
- `SKILL.md` router with the critical facts, environment table, quick start and
  reference directory.
- Nine reference documents: architecture and Vercel, crypto and client, auth,
  interactive sending, batch sending, receiving and sync, QR codes and offline
  modes, certificates/tokens/permissions, and errors/limits/testing.
- Six runnable TypeScript examples under `assets/examples/`.
- Vercel-specific architecture guidance: cron polling, Fluid compute limits,
  Blob uploads, multi-tenancy.
