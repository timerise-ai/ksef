/**
 * Typed KSeF fetch wrapper: bearer injection, error envelope parsing,
 * 429 Retry-After handling with jittered backoff.
 * Standalone version of `lib/ksef/client.ts` from references/crypto-and-client.md.
 */

export class KsefApiError extends Error {
  constructor(
    public httpStatus: number,
    public body: unknown,
    message?: string,
  ) {
    super(message ?? `KSeF API error: HTTP ${httpStatus}`);
  }

  /**
   * KSeF error code if the body carries one (e.g. 21470).
   * `exceptionDetailList` sits under `exception`, not at the body root.
   * `errors[]` is the RFC 9457 shape (opt in with `X-Error-Format: problem-details`);
   * the legacy `exception` envelope still ships but is marked deprecated.
   */
  get ksefCode(): number | undefined {
    const b = this.body as {
      exception?: { exceptionDetailList?: Array<{ exceptionCode?: number }> };
      errors?: Array<{ code?: number }>;
    } | null;
    return b?.exception?.exceptionDetailList?.[0]?.exceptionCode ?? b?.errors?.[0]?.code;
  }
}

export interface KsefFetchOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  accessToken?: string;
  maxRetries?: number;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ksefFetch<T>(
  baseUrl: string,
  path: string,
  opts: KsefFetchOptions = {},
): Promise<T> {
  const { method = 'GET', body, accessToken, maxRetries = 3, signal } = opts;
  let attempt = 0;

  for (;;) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      signal,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const contentType = res.headers.get('content-type') ?? '';
      return (contentType.includes('json') ? await res.json() : await res.text()) as T;
    }

    const errorBody: unknown = await res.json().catch(() => null);

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxRetries) {
      attempt += 1;
      const retryAfterSec = Number(res.headers.get('retry-after'));
      const delayMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000
          : Math.min(30_000, 2 ** attempt * 1000) + Math.random() * 500;
      await sleep(delayMs);
      continue;
    }

    throw new KsefApiError(res.status, errorBody);
  }
}

/** Read an env var or exit with a clear message — never hardcode secrets. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
