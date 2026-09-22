const PRIVATE_CACHE_POLICY_HEADERS = new Set([
  "age",
  "cache-control",
  "cdn-cache-control",
  "etag",
  "expires",
  "last-modified",
  "pragma",
  "surrogate-control",
]);

type HeaderTarget = {
  setHeader(name: string, value: string): unknown;
  removeHeader(name: string): unknown;
};

/**
 * Forwards representation headers while making private object responses
 * uncacheable. Stable packet-page URLs can point at newly sanitized bytes, so
 * upstream GCS validators and cache policy must never win by header order.
 */
export function applyPrivateObjectHeaders(
  source: Pick<Headers, "forEach">,
  target: HeaderTarget,
): void {
  for (const name of PRIVATE_CACHE_POLICY_HEADERS) target.removeHeader(name);
  source.forEach((value, name) => {
    if (!PRIVATE_CACHE_POLICY_HEADERS.has(name.toLowerCase())) {
      target.setHeader(name, value);
    }
  });
  // Apply these last: neither pre-existing middleware nor upstream metadata
  // may make authenticated sensitive bytes publicly or privately reusable.
  target.setHeader("Cache-Control", "private, no-store");
  target.setHeader("Pragma", "no-cache");
  target.setHeader("Expires", "0");
}