const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function parseOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

export function validOrigin(value, host, configured, secure) {
  const actual = parseOrigin(value);
  const direct = parseOrigin(`${secure ? "https" : "http"}://${host}`);
  if (!actual || !direct) return false;
  if (!configured) return actual.origin === direct.origin;
  if (actual.origin === configured.origin) return true;
  // Local aliases are safe only on the same protocol/port and when the browser's
  // Origin also matches the actual Host. Never widen a public-domain allowlist.
  return (
    loopback.has(configured.hostname) &&
    loopback.has(actual.hostname) &&
    loopback.has(direct.hostname) &&
    actual.protocol === configured.protocol &&
    actual.port === configured.port &&
    actual.origin === direct.origin
  );
}
