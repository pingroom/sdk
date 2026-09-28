import { PingRoomError } from '../errors.js';

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

/**
 * Refuse to carry a bearer credential over plain http to a non-loopback host —
 * a token on the wire over http is a token leaked. https always passes; http is
 * allowed only to loopback dev hosts, or anywhere when `allowInsecure` is set.
 */
export function assertSecureUrl(rawUrl: string, allowInsecure: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Never echo the input: an incoming-webhook URL carries its secret in the
    // path, and error messages end up in logs.
    throw new PingRoomError('Invalid URL (value withheld because it may contain a secret).', {
      code: 'invalid_url',
    });
  }
  if (url.protocol === 'https:') {
    return url;
  }
  if (url.protocol === 'http:' && (allowInsecure || isLoopbackHost(url.hostname))) {
    return url;
  }
  throw new PingRoomError(
    `Refusing to send credentials over an insecure URL (${url.protocol}//${url.host}). ` +
      'Use https, or set allowInsecure: true for trusted local development.',
    { code: 'insecure_url' },
  );
}

/**
 * Strip a URL out of an error message, keeping only its origin. An
 * incoming-webhook URL carries its secret in the path, and fetch
 * implementations (node-fetch, for one) quote the requested URL in their
 * errors, so a message copied from one must not reach a caller's logs as-is.
 */
export function redactUrlInMessage(message: string, url: URL, rawUrl: string): string {
  const withheld = `${url.origin}/[redacted]`;
  let out = message;
  for (const full of [rawUrl, url.href]) {
    if (full) out = out.split(full).join(withheld);
  }
  for (const tail of [`${url.pathname}${url.search}${url.hash}`, url.pathname]) {
    if (tail.length > 1) out = out.split(tail).join('/[redacted]');
  }
  return out;
}
