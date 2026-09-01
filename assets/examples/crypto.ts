/**
 * KSeF cryptography helpers — standalone version of `lib/ksef/crypto.ts`
 * from references/crypto-and-client.md. Only `node:crypto`, no dependencies.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
  constants,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';

// ---------- session encryption material ----------

export interface SessionEncryption {
  cipherKey: Buffer; // 32 bytes (AES-256) — server-side secret
  iv: Buffer;        // 16 bytes
}

export function generateSessionEncryption(): SessionEncryption {
  return { cipherKey: randomBytes(32), iv: randomBytes(16) };
}

// ---------- AES-256-CBC (PKCS#7) ----------
//
// The payload is the RAW ciphertext: the IV is NOT prepended. It is sent once,
// separately, in `encryption.initializationVector` at session/export open, and
// reused for every document of that session. (The MF docs claim the IV is a
// prefix — the official C#/Java clients prove otherwise; prepending it yields
// invoice status 430 "size does not match the declared value".)

export function encryptDocument(plaintext: Buffer, enc: SessionEncryption): Buffer {
  const cipher = createCipheriv('aes-256-cbc', enc.cipherKey, enc.iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptDocument(encrypted: Buffer, cipherKey: Buffer, iv: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// ---------- RSAES-OAEP (SHA-256 + MGF1-SHA-256) key wrapping ----------

export function wrapSymmetricKey(cipherKey: Buffer, mfPublicKey: KeyObject): string {
  return publicEncrypt(
    { key: mfPublicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    cipherKey,
  ).toString('base64');
}

export interface EncryptionInfo {
  encryptedSymmetricKey: string;
  initializationVector: string;
  publicKeyId?: string;
}

export function buildEncryptionInfo(
  enc: SessionEncryption,
  mfPublicKey: KeyObject,
  publicKeyId: string,
): EncryptionInfo {
  return {
    encryptedSymmetricKey: wrapSymmetricKey(enc.cipherKey, mfPublicKey),
    initializationVector: enc.iv.toString('base64'),
    publicKeyId,
  };
}

// ---------- hashes ----------

export function sha256Base64(data: Buffer): string {
  return createHash('sha256').update(data).digest('base64');
}

export function sha256Base64Url(data: Buffer): string {
  return createHash('sha256').update(data).digest('base64url');
}

export interface FileMetadata {
  hashSha256Base64: string;
  sizeBytes: number;
}

export function fileMetadata(data: Buffer): FileMetadata {
  return { hashSha256Base64: sha256Base64(data), sizeBytes: data.byteLength };
}

// ---------- KSeF-token auth encryption ----------

export function encryptKsefToken(
  ksefToken: string,
  challengeTimestampMs: number,
  mfPublicKey: KeyObject,
): string {
  return publicEncrypt(
    { key: mfPublicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(`${ksefToken}|${challengeTimestampMs}`, 'utf8'),
  ).toString('base64');
}

// ---------- MF public keys ----------

export type KeyUsage = 'SymmetricKeyEncryption' | 'KsefTokenEncryption';

export interface PublicKeyCertificate {
  certificate: string;
  certificateId: string;
  publicKeyId: string;
  validFrom: string;
  validTo: string;
  usage: KeyUsage[];
}

let cache: { fetchedAt: number; certs: PublicKeyCertificate[] } | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function getMfPublicKey(
  baseUrl: string,
  usage: KeyUsage,
  opts: { forceRefresh?: boolean } = {},
): Promise<{ key: KeyObject; publicKeyId: string }> {
  if (opts.forceRefresh || !cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS) {
    const res = await fetch(`${baseUrl}/security/public-key-certificates`);
    if (!res.ok) throw new Error(`Failed to fetch MF public keys: HTTP ${res.status}`);
    cache = { fetchedAt: Date.now(), certs: (await res.json()) as PublicKeyCertificate[] };
  }
  const now = Date.now();
  const chosen = cache.certs
    .filter(
      (c) =>
        c.usage.includes(usage) &&
        Date.parse(c.validFrom) <= now &&
        now <= Date.parse(c.validTo),
    )
    .sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom))[0];
  if (!chosen) throw new Error(`No valid MF public key for usage ${usage}`);
  const x509 = new X509Certificate(Buffer.from(chosen.certificate, 'base64'));
  return { key: x509.publicKey, publicKeyId: chosen.publicKeyId };
}
