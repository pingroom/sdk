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
    throw new PingRoomError(`Invalid URL: ${rawUrl}`, { code: 'invalid_url' });
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
