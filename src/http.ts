/** Errors carry an HTTP status and a {"detail": ...} body; the pages show `detail`. */
export class HttpError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}

/** Security headers on every Worker response (the pages get theirs from public/_headers). A JSON
 * response may load nothing and be framed by nobody (security plan step 4). */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...API_SECURITY_HEADERS, ...headers },
  });
}

export const unprocessable = (detail: string) => new HttpError(422, detail);

/** Request bodies are small JSON objects (the largest, 50 tags, is ~3.5 KB). Anything bigger is
 * refused before it's read into memory or parsed. */
export const MAX_BODY_BYTES = 16 * 1024;
export const bodyTooLarge = () => new HttpError(413, `request body too large (at most ${MAX_BODY_BYTES / 1024} KiB)`);

/** The request's JSON body, read up to MAX_BODY_BYTES (also when no Content-Length is sent).
 * Throws HttpError 413 past that, or the parse error for a body that isn't JSON, like
 * request.json() did. */
export async function jsonBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw bodyTooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw bodyTooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Optional integer query param; 422 if present but not an integer in [min, max]. */
export function intParam(url: URL, name: string, opts: { def?: number; min?: number; max?: number } = {}): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return opts.def;
  if (!/^-?\d+$/.test(raw)) throw unprocessable(`${name} must be an integer`);
  const n = Number(raw);
  if (opts.min !== undefined && n < opts.min) throw unprocessable(`${name} must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw unprocessable(`${name} must be <= ${opts.max}`);
  return n;
}

/** Optional YYYY-MM-DD query param. */
export function dateParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw unprocessable(`${name} must be a date (YYYY-MM-DD)`);
  }
  return raw;
}
