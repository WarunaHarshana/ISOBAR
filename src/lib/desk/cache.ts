type Entry<T> = { at: number; value: T };

const store = new Map<string, Entry<unknown>>();

export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
  return fn().then((value) => {
    store.set(key, { at: Date.now(), value });
    return value;
  });
}

/** Test helper — drop in-memory HTTP cache between cases. */
export function _resetCache() {
  store.clear();
}

/**
 * Non-2xx response. The message keeps the historical "<status> <text> ... for <url>"
 * shape (callers / tests match on it); status, Retry-After and the API's own
 * reason (e.g. Open-Meteo's `{"reason":"Hourly API request limit exceeded..."}`)
 * are also exposed as fields.
 */
export class HttpError extends Error {
  status: number;
  retryAfter: string | null;
  reason: string | null;
  url: string;
  constructor(status: number, statusText: string, retryAfter: string | null, reason: string | null, url: string) {
    super(`${status} ${statusText}${retryAfter ? ` retry-after=${retryAfter}` : ""}${reason ? ` (${reason})` : ""} for ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.reason = reason;
    this.url = url;
  }
}

async function errorReason(res: Response): Promise<string | null> {
  try {
    const text = (await res.text()).slice(0, 2000);
    try {
      const body = JSON.parse(text) as { reason?: unknown };
      if (typeof body?.reason === "string" && body.reason.trim()) return body.reason.trim().slice(0, 160);
    } catch {
      /* not JSON */
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        accept: "application/json",
        "user-agent": "IsobarDesk/1.0 (Polymarket weather desk)",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const ra = res.headers.get("retry-after");
      const reason = await errorReason(res);
      throw new HttpError(res.status, res.statusText, ra, reason, url);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}
