/**
 * Send one FA(3) invoice through an interactive (online) session:
 * open session → AES-encrypt → send → short-poll status → close.
 *
 * Usage:
 *   KSEF_BASE_URL=... KSEF_CONTEXT_NIP=... KSEF_KSEF_TOKEN=... \
 *   npx tsx send-invoice-online.ts ./invoice-fa3.xml
 */
import { readFileSync } from 'node:fs';
import {
  buildEncryptionInfo,
  encryptDocument,
  fileMetadata,
  generateSessionEncryption,
  getMfPublicKey,
  type SessionEncryption,
} from './crypto';
import { ksefFetch, requireEnv } from './ksef-client';
import { authenticateWithKsefToken } from './auth-ksef-token';

const FORM_CODE_FA3 = { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function openOnlineSession(baseUrl: string, accessToken: string) {
  const enc = generateSessionEncryption();
  const { key, publicKeyId } = await getMfPublicKey(baseUrl, 'SymmetricKeyEncryption');
  const session = await ksefFetch<{ referenceNumber: string; validUntil: string }>(
    baseUrl,
    '/sessions/online',
    {
      method: 'POST',
      accessToken,
      body: {
        formCode: FORM_CODE_FA3,
        encryption: buildEncryptionInfo(enc, key, publicKeyId),
      },
    },
  );
  return { ...session, enc };
}

export async function sendInvoice(
  baseUrl: string,
  accessToken: string,
  sessionRef: string,
  enc: SessionEncryption,
  invoiceXml: Buffer,
): Promise<{ referenceNumber: string }> {
  const encrypted = encryptDocument(invoiceXml, enc);
  const plain = fileMetadata(invoiceXml);
  const cipher = fileMetadata(encrypted);
  return ksefFetch(baseUrl, `/sessions/online/${sessionRef}/invoices`, {
    method: 'POST',
    accessToken,
    body: {
      invoiceHash: plain.hashSha256Base64,
      invoiceSize: plain.sizeBytes,
      encryptedInvoiceHash: cipher.hashSha256Base64,
      encryptedInvoiceSize: cipher.sizeBytes,
      encryptedInvoiceContent: encrypted.toString('base64'),
    },
  });
}

export interface InvoiceStatus {
  status: {
    code: number;
    description?: string;
    /** Array of strings — the specific reason behind an umbrella code like 430. */
    details?: string[] | null;
    /** String-keyed object (NOT a [{key,value}] list). 440 → originalKsefNumber. */
    extensions?: Record<string, string | null> | null;
  };
  ksefNumber?: string;
  acquisitionDate?: string;
  upoDownloadUrl?: string;
}

/** Everything KSeF told us about a rejection — always log/persist this, not just the code. */
export function describeStatus(st: InvoiceStatus): string {
  return [st.status.description, ...(st.status.details ?? [])].filter(Boolean).join(' | ');
}

export async function pollInvoice(
  baseUrl: string,
  accessToken: string,
  sessionRef: string,
  invoiceRef: string,
  timeoutMs = 60_000,
): Promise<InvoiceStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await ksefFetch<InvoiceStatus>(
      baseUrl,
      `/sessions/${sessionRef}/invoices/${invoiceRef}`,
      { accessToken },
    );
    if (st.status.code >= 200) return st; // 200 accepted; >200 rejected (440 = duplicate)
    if (Date.now() > deadline) return st; // still 100/150 — caller keeps polling later
    await sleep(2_000);
  }
}

// ---- CLI entry ----
if (process.argv[1]?.endsWith('send-invoice-online.ts')) {
  const xmlPath = process.argv[2];
  if (!xmlPath) {
    console.error('Usage: npx tsx send-invoice-online.ts <invoice-fa3.xml>');
    process.exit(1);
  }
  const baseUrl = requireEnv('KSEF_BASE_URL');

  (async () => {
    const invoiceXml = readFileSync(xmlPath);
    const { accessToken } = await authenticateWithKsefToken({
      baseUrl,
      ksefToken: requireEnv('KSEF_KSEF_TOKEN'),
      contextNip: requireEnv('KSEF_CONTEXT_NIP'),
    });

    const { referenceNumber: sessionRef, enc } = await openOnlineSession(
      baseUrl,
      accessToken.token,
    );
    console.log('Session:', sessionRef);

    const { referenceNumber: invoiceRef } = await sendInvoice(
      baseUrl,
      accessToken.token,
      sessionRef,
      enc,
      invoiceXml,
    );
    console.log('Invoice reference:', invoiceRef);

    const st = await pollInvoice(baseUrl, accessToken.token, sessionRef, invoiceRef);
    console.log('Status:', st.status.code, describeStatus(st));
    if (st.ksefNumber) console.log('KSeF number:', st.ksefNumber);
    if (st.status.code === 440) {
      // Duplicate: the invoice is already in KSeF from an earlier session.
      console.log('Duplicate of:', st.status.extensions?.originalKsefNumber);
      console.log('Original session:', st.status.extensions?.originalSessionReferenceNumber);
      console.log('Fetch its UPO from the ORIGINAL session, not this one.');
    }

    await ksefFetch(baseUrl, `/sessions/online/${sessionRef}/close`, {
      method: 'POST',
      accessToken: accessToken.token,
    });
    console.log('Session closed (session UPO will be generated asynchronously).');
  })().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
