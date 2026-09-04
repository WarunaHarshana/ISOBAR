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
      const safeUrl = url.replace(/([?&]apikey=)[^&]*/gi, "$1***");
      throw new Error(`${res.status} ${res.statusText}${ra ? ` retry-after=${ra}` : ""} for ${safeUrl}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}
