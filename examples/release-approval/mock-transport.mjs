import { PingRoom } from '../../dist/index.js';

export const DEMO_ORIGIN = 'https://approval-demo.invalid';
export const DEMO_TOKEN = 'synthetic-offline-token';

/** In-memory transport. It never calls fetch, sockets, or a real PingRoom API. */
export function createOfflineClient({ decision = 'approve', onCreate, onWait, timeoutMs = 1000 } = {}) {
  const calls = [];
  let created;
  const fetch = async (url, init) => {
    const target = new URL(url);
    if (target.origin !== DEMO_ORIGIN || init.headers.Authorization !== `Bearer ${DEMO_TOKEN}`) {
      throw new Error('Offline transport accepts only its synthetic origin and token.');
    }
    calls.push({ method: init.method, path: target.pathname, body: init.body ? JSON.parse(init.body) : null });
    let response;
    if (init.method === 'POST' && /^\/api\/agent\/rooms\/[^/]+\/approvals$/.test(target.pathname)) {
      const request = JSON.parse(init.body);
      created = {
        ...request, id: 'offline-approval-1', status: 'pending', decision: null, decided_at: null,
        expires_at: new Date(Math.floor(Date.now() / 1000) * 1000 + request.ttl * 1000).toISOString(),
        room_code: decodeURIComponent(target.pathname.split('/')[4]),
      };
      response = onCreate ? await onCreate(structuredClone(created), init.signal) : created;
    } else if (init.method === 'GET' && target.pathname === '/api/agent/approvals/offline-approval-1/wait' && created) {
      response = {
        ...created, status: 'decided', decision,
        decided_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
      };
      if (onWait) response = await onWait(structuredClone(response), init.signal);
    } else {
      throw new Error('Unexpected offline API request.');
    }
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  };
  return { client: new PingRoom({ token: DEMO_TOKEN, baseUrl: DEMO_ORIGIN, fetch, timeoutMs }), calls, fetch };
}

export function waitUntilAborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
