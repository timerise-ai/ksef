/**
 * KSeF QR verification links: KOD I (all invoices) and KOD II (offline
 * invoices, signed with an Offline-type KSeF certificate private key).
 *
 * URL construction + signing needs only node:crypto. Rendering a PNG needs a
 * QR library (`npm i qrcode`), see the commented block at the bottom.
 */
import { createPrivateKey, sign, constants, type KeyObject } from 'node:crypto';
import { sha256Base64Url } from './crypto';

export type QrHost =
  | 'https://qr-test.ksef.mf.gov.pl'
  | 'https://qr-demo.ksef.mf.gov.pl'
  | 'https://qr.ksef.mf.gov.pl';

/** P_1 date from the invoice XML (YYYY-MM-DD) → DD-MM-YYYY used in links. */
function toLinkDate(p1IsoDate: string): string {
  const [y, m, d] = p1IsoDate.split('-');
  return `${d}-${m}-${y}`;
}

/** KOD I — invoice verification link. Label under the QR: KSeF number or "OFFLINE". */
export function buildKodI(opts: {
  qrHost: QrHost;
  sellerNip: string;
  issueDateP1: string;
  invoiceXml: Buffer;
}): string {
  const hash = sha256Base64Url(opts.invoiceXml);
  return `${opts.qrHost}/invoice/${opts.sellerNip}/${toLinkDate(opts.issueDateP1)}/${hash}`;
}

/** KOD II — issuer certificate link (offline invoices only). Label: "CERTYFIKAT". */
export function buildKodII(opts: {
  qrHost: QrHost;
  contextIdentifierType: 'Nip' | 'InternalId' | 'NipVatUe' | 'PeppolId';
  contextIdentifierValue: string;
  sellerNip: string;
  certificateSerialNumber: string;
  invoiceXml: Buffer;
  privateKeyPem: string; // Offline-type KSeF certificate key — server-only secret
}): string {
  const hash = sha256Base64Url(opts.invoiceXml);
  const unsigned =
    `${opts.qrHost}/certificate/${opts.contextIdentifierType}/${opts.contextIdentifierValue}` +
    `/${opts.sellerNip}/${opts.certificateSerialNumber}/${hash}`;

  // Sign the URL WITHOUT the "https://" prefix and WITHOUT a trailing slash.
  const toSign = Buffer.from(unsigned.replace(/^https:\/\//, ''), 'utf8');
  const signature = signUrl(toSign, createPrivateKey(opts.privateKeyPem));

  return `${unsigned}/${signature.toString('base64url')}`;
}

function signUrl(data: Buffer, key: KeyObject): Buffer {
  if (key.asymmetricKeyType === 'ec') {
    // ECDSA P-256/SHA-256, IEEE P1363 (r‖s) encoding — recommended by the docs.
    return sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' });
  }
  // RSASSA-PSS: SHA-256, MGF1-SHA-256, 32-byte salt, key ≥ 2048 bit.
  return sign('sha256', data, {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
}

// ---- Rendering (requires `npm i qrcode`) ----
//
// import QRCode from 'qrcode';
//
// export async function qrPng(url: string): Promise<Buffer> {
//   return QRCode.toBuffer(url, { errorCorrectionLevel: 'M', scale: 5, margin: 2 });
// }
//
// Compose the label (KSeF number / "OFFLINE" / "CERTYFIKAT") under the image
// in your PDF or print template.
