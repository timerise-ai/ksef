# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this repository is

A **Claude Code skill package** — markdown plus standalone TypeScript, no build,
no tests, no dependencies. It teaches an agent to build KSeF API 2.0
integrations (Krajowy System e-Faktur — Poland's national e-invoicing system)
in Next.js App Router apps on Vercel. Published as
[`timerise-ai/ksef`](https://github.com/timerise-ai/ksef) and installed by
cloning into `~/.claude/skills/ksef`.

It is a **documentation artifact**, not an application. The deliverables are
`SKILL.md`, `references/*.md`, and the runnable examples in
`assets/examples/*.ts`.

## Structure

- `SKILL.md` — thin router. The frontmatter `name`/`description` are the
  activation surface. The body carries the critical facts, the environment
  table, the quick start, and the **Reference Directory table** mapping trigger
  keywords to `references/*.md`. Keep it under ~150 lines; details belong in
  references.
- `references/*.md` — one focused document per scenario, each ending with a
  `## Sources` section linking the official docs at
  https://github.com/CIRFMF/ksef-api. Keep each under ~500 lines.
  `architecture-and-vercel.md` is the greenfield entry point;
  `crypto-and-client.md` holds the primitives every other file builds on.
- `assets/examples/*.ts` — standalone scripts mirroring the code shown in
  references (`npx tsx <script>`). Only `node:crypto` + `fetch`; third-party
  deps (`qrcode`, `fflate`, `@peculiar/x509`) appear only as clearly marked
  optional snippets.

## Editing conventions

- **No secrets anywhere** — examples read env vars (`KSEF_KSEF_TOKEN` etc.)
  and never print token values. Preserve this property in every edit.
- **No high-entropy literals** — example hashes/signatures from the official
  docs must be replaced with structural placeholders like
  `{invoiceHashBase64Url}`; entropy-based secret scanners (Snyk Agent Scan
  W008) flag realistic Base64 values as leaked secrets. Scan a clean export
  (`git archive HEAD | tar -x -C <tmpdir>`), not the working tree — `.git`
  objects are high-entropy noise.
- **Source of truth**: the official docs and OpenAPI spec at
  https://github.com/CIRFMF/ksef-api (Swagger:
  https://api-test.ksef.mf.gov.pl/docs/v2). Any change to endpoint shapes,
  status codes, limits, or crypto parameters must be verified there first —
  never from memory. Check `api-changelog.md` in that repo for what changed.
- **Do not remove the odd-looking parts.** Raw ciphertext with no IV prefix,
  CRC-8 over exactly 32 characters, `exceptionDetailList` read under
  `exception`, concatenating export parts before unzipping, the seller-NIP
  equality check — each is a documented defect that cost a production
  integration real time. `CHANGELOG.md` records which and why; read it before
  "simplifying" anything.
- **Volatile facts** (statutory dates, rate-limit numbers, Vercel platform
  limits) are deliberately phrased as snapshots with pointers to the live
  source (`GET /rate-limits`, podatki.gov.pl, Vercel docs). Keep that framing.
- **Keep the file tables in sync** with `references/` — the Reference Directory
  table in `SKILL.md` (with its trigger keywords) and the file table in
  `README.md` both list every reference. Internal links are relative
  (`references/...`, `assets/...`); verify they resolve after renames. The
  skill must stay self-contained — no links to local paths outside the repo.
- English prose; Polish domain terms (UPO, NIP, sesja wsadowa) kept with a
  translation on first use.
- **The version lives in exactly one place**: the git tag, described by a
  `CHANGELOG.md` entry (Keep a Changelog format, semver, `v`-prefixed tags,
  `chore(release): X.Y.Z` commits). `SKILL.md` frontmatter carries only `name`
  and `description`, and the README carries no version history — a second copy
  of the number is a copy that drifts.

## Verifying changes

- Type-check examples (`node_modules/` here is gitignored; a bare `npx tsc`
  resolves to an unrelated decoy package, and without `@types/node` you get
  ~39 spurious `TS2591` errors):

  ```bash
  cd assets/examples
  npm i -D typescript @types/node
  npx tsc --noEmit --strict --target es2022 --module nodenext \
    --moduleResolution nodenext --skipLibCheck --types node *.ts
  ```
- Sanity-run pure-crypto helpers with `npx tsx` (AES round-trip, hash
  helpers) — they have no network dependencies.
- Verify claims against the live OpenAPI rather than the narrative docs, which
  lag it (`curl -s https://api-test.ksef.mf.gov.pl/docs/v2/openapi.json`).
  Response-shape bugs (wrong nesting, wrong field level) type-check clean and
  are invisible to secret/SAST scanners — exercise the parse with a realistic
  body instead.
- Live testing requires TEST-environment credentials; the bootstrap
  walkthrough is in `references/errors-limits-and-testing.md`.
