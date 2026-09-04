import { PingRoomError, PingRoomNetworkError, PingRoomTimeoutError } from './errors.js';
import { combineSignals } from './internal/async.js';
import { assertSecureUrl } from './internal/url.js';
import type { FetchLike } from './types.js';
import { VERSION } from './version.js';

export interface HttpClientOptions {
  baseUrl: string;
  token?: string | null;
  timeoutMs?: number;
  fetch?: FetchLike;
  userAgent?: string;
  allowInsecure?: boolean;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Send the Authorization header (default true). Public endpoints pass false. */
  auth?: boolean;
  /** Per-call timeout override in ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Thin authenticated fetch wrapper. Holds the token privately, enforces https
 * for credentialed traffic, applies a timeout, and maps non-2xx responses to a
 * PingRoomError. The token is never written into thrown errors or logs.
 */
export class HttpClient {
  private token: string | null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;

  constructor(options: HttpClientOptions) {
    const base = assertSecureUrl(options.baseUrl, options.allowInsecure ?? false);
    // Normalise: keep origin + any path prefix, drop a trailing slash.
    this.baseUrl = (base.origin + base.pathname).replace(/\/$/, '');
    this.token = options.token ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const f = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) {
      throw new PingRoomError(
        'No fetch implementation available. Use Node >= 18, a modern browser, or pass `fetch`.',
        { code: 'no_fetch' },
      );
    }
    this.fetchImpl = f;
    this.userAgent = options.userAgent ?? `pingroom-sdk/${VERSION}`;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    return this.send(method, path, opts, (res) => this.parse<T>(res));
  }

  /**
   * The undecoded Response, for endpoints that return bytes rather than JSON.
   * Non-2xx still raises a PingRoomError so callers never read an error body
   * as if it were content.
   */
  async raw(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    return this.send(method, path, {
      ...opts,
      headers: { Accept: '*/*', ...opts.headers },
    }, async (res) => {
      if (!res.ok) {
        // Route the failure through the shared JSON error mapping.
        await this.parse<unknown>(res);
      }
      return res;
    });
  }

  private async send<T>(
    method: string,
    path: string,
    opts: RequestOptions,
    consume: (res: Response) => Promise<T>,
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
      ...opts.headers,
    };

    if (opts.auth !== false) {
      if (!this.token) {
        throw new PingRoomError(
          'This call requires an agent token. Pass `token` to the client or call setToken().',
          { code: 'no_token' },
        );
      }
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    // FormData is passed through untouched: the runtime has to generate the
    // multipart boundary itself, so setting Content-Type here would corrupt it.
    let payload: string | FormData | undefined;
    if (opts.body instanceof FormData) {
      payload = opts.body;
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new PingRoomTimeoutError()), timeoutMs);
    const signal = combineSignals(controller.signal, opts.signal);

    try {
      // A 307/308 can forward pairing secrets or uploaded bytes to another
      // origin even when fetch strips the Authorization header.
      const res = await this.fetchImpl(url, { method, headers, body: payload, signal, redirect: 'error' });
      // Keep the deadline active while reading JSON, including error bodies.
      return await consume(res);
    } catch (err) {
      if (signal.aborted) {
        throw signal.reason;
      }
      // Our own timeout reason propagates as the rejection.
      if (err instanceof PingRoomError) {
        throw err;
      }
      if (isAbortError(err) || opts.signal?.aborted) {
        throw err;
      }
      throw new PingRoomNetworkError(`Network request failed: ${errMessage(err)}`, err);
    } finally {
      clearTimeout(timer);
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    if (res.status === 204) {
      return undefined as T;
    }
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    if (!res.ok) {
      throw PingRoomError.fromResponse(res.status, json, res.headers);
    }
    return json as T;
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const full = /^https?:\/\//i.test(path)
      ? path
      : this.baseUrl + (path.startsWith('/') ? path : `/${path}`);
    if (!query) {
      return full;
    }
    const url = new URL(full);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) {
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}

function isAbortError(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
