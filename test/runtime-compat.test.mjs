import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomError, sendIncomingWebhook } from '../dist/index.js';

const HOOK = 'https://api.pingroom.invalid/api/webhook/fixture-secret';

/**
 * Browsers and Cloudflare Workers reject a fetch whose receiver is not the
 * global object ("Illegal invocation"), and Workers reject `redirect: 'error'`
 * while building the Request. Node's fetch enforces neither, so this stub does.
 */
function edgeRuntimeFetch(calls) {
  return function fetch(url, init) {
    if (this !== globalThis) {
      throw new TypeError('Illegal invocation: function called with incorrect this reference');
    }
    if (init?.redirect === 'error') {
      throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    }
    calls.push({ url, init });
    const body = new URL(url).pathname === '/api/agent/rooms' ? '[]' : '{"success":true}';
    return Promise.resolve(new Response(body, { status: 200 }));
  };
}

async function withGlobalFetch(fetchImpl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('the default client fetch keeps the global receiver and a redirect mode edge runtimes accept', async () => {
  const calls = [];
  await withGlobalFetch(edgeRuntimeFetch(calls), async () => {
    const pr = new PingRoom({ token: 'fixture-token', baseUrl: 'https://api.pingroom.invalid' });
    assert.deepEqual(await pr.rooms.list(), []);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
});

test('sendIncomingWebhook with the default fetch keeps the global receiver and manual redirects', async () => {
  const calls = [];
  await withGlobalFetch(edgeRuntimeFetch(calls), async () => {
    assert.deepEqual(await sendIncomingWebhook(HOOK, { message: 'hi' }), { success: true });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
});

test('an injected fetch is called as a plain function, so an unbound global fetch works too', async () => {
  const calls = [];
  // `fetch: globalThis.fetch` passed unbound must not be invoked as a method
  // of the SDK's HTTP client. A plain call has an undefined receiver, which
  // WebIDL maps to the global object.
  const unbound = function fetch(url, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    calls.push({ url, init });
    return Promise.resolve(new Response('[]'));
  };
  const pr = new PingRoom({ token: 'fixture-token', fetch: unbound });
  assert.deepEqual(await pr.rooms.list(), []);
  assert.equal(calls.length, 1);
});

// What a manual redirect looks like: browsers filter it to an opaque redirect
// with status 0, while Node and Workers hand back the 3xx itself.
const redirects = [
  ['an opaque redirect', () => ({
    type: 'opaqueredirect', status: 0, ok: false, headers: new Headers(), body: null, text: async () => '',
  })],
  ['a 302', () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid/' } })],
  ['a 307', () => new Response(null, { status: 307, headers: { Location: 'https://elsewhere.invalid/' } })],
];

for (const [label, respond] of redirects) {
  test(`${label} is refused as redirect_refused by the client and by sendIncomingWebhook`, async () => {
    let requests = 0;
    const fetchImpl = async () => {
      requests += 1;
      return respond();
    };
    const pr = new PingRoom({ token: 'fixture-token', fetch: fetchImpl });
    const refused = (error) => error instanceof PingRoomError && error.code === 'redirect_refused';
    await assert.rejects(pr.rooms.list(), refused);
    await assert.rejects(pr.attachments.content('att-1'), refused);
    await assert.rejects(sendIncomingWebhook(HOOK, { message: 'hi' }, { fetch: fetchImpl }), (error) => {
      // The webhook URL carries its secret in the path; it must not leak.
      return refused(error) && !error.message.includes('fixture-secret');
    });
    assert.equal(requests, 3);
  });
}
