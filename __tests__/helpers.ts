/** Builds a Response-alike good enough for lib/http's readBody(). */
export function jsonResponse(
  body: unknown,
  { status = 200 }: { status?: number } = {}
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * What a dead ngrok tunnel actually returns: HTTP 404 with an HTML error
 * page. This is the exact shape that used to sign staff members out.
 */
export function htmlResponse(status = 404): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "text/html" : null) },
    text: async () => "<!DOCTYPE html><html><body>Tunnel offline</body></html>",
  } as unknown as Response;
}

/** A fetch that never resolves until its signal aborts — for timeouts. */
export function hangingFetch() {
  return jest.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const fail = () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        };
        // Match the real fetch: an already-aborted signal rejects at once
        // rather than waiting for an "abort" event that will never fire.
        if (init?.signal?.aborted) return fail();
        init?.signal?.addEventListener("abort", fail);
      })
  );
}

export function setFetch(impl: jest.Mock) {
  (global as unknown as { fetch: unknown }).fetch = impl;
  return impl;
}
