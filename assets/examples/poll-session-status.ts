/**
 * Cron-tick style status poll: list a session's invoices, report outcomes,
 * download UPOs for accepted ones.
 *
 * Usage:
 *   KSEF_BASE_URL=... KSEF_CONTEXT_NIP=... KSEF_KSEF_TOKEN=... \
 *   npx tsx poll-session-status.ts <sessionReferenceNumber>
 */
import { writeFileSync } from 'node:fs';
import { ksefFetch, requireEnv } from './ksef-client';
import { authenticateWithKsefToken } from './auth-ksef-token';

interface SessionInvoice {
  ordinalNumber: number;
  referenceNumber: string;
  invoiceNumber?: string;
  ksefNumber?: string;
  invoiceFileName?: string;
  upoDownloadUrl?: string;
  status: {
    code: number;
    description?: string;
    details?: string[] | null;
    extensions?: Record<string, string | null> | null;
  };
}

export async function listSessionInvoices(
  baseUrl: string,
  accessToken: string,
  sessionRef: string,
): Promise<SessionInvoice[]> {
  const all: SessionInvoice[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await ksefFetch<{
      continuationToken?: string;
      invoices: SessionInvoice[];
    }>(
      baseUrl,
      `/sessions/${sessionRef}/invoices${
        continuationToken ? `?continuationToken=${encodeURIComponent(continuationToken)}` : ''
      }`,
      { accessToken },
    );
    all.push(...page.invoices);
    continuationToken = page.continuationToken ?? undefined;
  } while (continuationToken);
  return all;
}

/** UPO download links are pre-authorized: plain GET, NO Authorization header. */
export async function downloadUpo(upoDownloadUrl: string): Promise<Buffer> {
  const res = await fetch(upoDownloadUrl);
  if (!res.ok) throw new Error(`UPO download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---- CLI entry ----
if (process.argv[1]?.endsWith('poll-session-status.ts')) {
  const sessionRef = process.argv[2];
  if (!sessionRef) {
    console.error('Usage: npx tsx poll-session-status.ts <sessionReferenceNumber>');
    process.exit(1);
  }
  const baseUrl = requireEnv('KSEF_BASE_URL');

  (async () => {
    const { accessToken } = await authenticateWithKsefToken({
      baseUrl,
      ksefToken: requireEnv('KSEF_KSEF_TOKEN'),
      contextNip: requireEnv('KSEF_CONTEXT_NIP'),
    });

    const session = await ksefFetch<{
      status: { code: number; description?: string };
      invoiceCount?: number;
      successfulInvoiceCount?: number;
      failedInvoiceCount?: number;
    }>(baseUrl, `/sessions/${sessionRef}`, { accessToken: accessToken.token });

    console.log(
      `Session ${sessionRef}: status ${session.status.code}`,
      `(ok: ${session.successfulInvoiceCount ?? '-'}, failed: ${session.failedInvoiceCount ?? '-'})`,
    );

    for (const inv of await listSessionInvoices(baseUrl, accessToken.token, sessionRef)) {
      console.log(
        `#${inv.ordinalNumber} ${inv.invoiceFileName ?? inv.referenceNumber}:`,
        `status ${inv.status.code}`,
        inv.ksefNumber ? `→ ${inv.ksefNumber}` : '',
      );
      // The reason behind an umbrella code (430 = schema | hash | size | encoding)
      // lives only in description/details — never persist the bare code.
      if (inv.status.code > 200) {
        console.log(
          '   ',
          [inv.status.description, ...(inv.status.details ?? [])].filter(Boolean).join(' | '),
        );
      }
      if (inv.status.code === 200 && inv.ksefNumber && inv.upoDownloadUrl) {
        const upo = await downloadUpo(inv.upoDownloadUrl);
        const file = `upo-${inv.ksefNumber}.xml`;
        writeFileSync(file, upo);
        console.log(`   UPO saved: ${file}`);
      }
      // Duplicate: the UPO exists, but only in the session that first accepted it.
      if (inv.status.code === 440) {
        const originalKsefNumber = inv.status.extensions?.originalKsefNumber;
        const originalSessionRef = inv.status.extensions?.originalSessionReferenceNumber;
        if (originalKsefNumber && originalSessionRef) {
          const upo = await ksefFetch<string>(
            baseUrl,
            `/sessions/${originalSessionRef}/invoices/ksef/${originalKsefNumber}/upo`,
            { accessToken: accessToken.token },
          );
          const file = `upo-${originalKsefNumber}.xml`;
          writeFileSync(file, upo);
          console.log(`   duplicate of ${originalKsefNumber}; UPO saved: ${file}`);
        }
      }
    }
  })().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
