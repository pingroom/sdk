import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomError } from '../dist/index.js';

const result = {
  message: 'Gift redeemed.', kind: 'gift', reward_days: 30, package: 'monthly',
  lifetime: false, plan: 'pro', plan_expires_at: '2026-10-05T12:00:00Z',
};

test('redeemCode uses the authenticated account endpoint and preserves the entitlement', async () => {
  const calls = [];
  const pr = new PingRoom({ token: 'agent_test', fetch: async (url, init) => {
    calls.push({ url, ...init });
    return new Response(JSON.stringify(result));
  } });
  assert.deepEqual(await pr.redeemCode('  ab12cd34ef56\n'), result);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/api/agent/redeem-code');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, 'Bearer agent_test');
  assert.deepEqual(JSON.parse(calls[0].body), { code: 'AB12CD34EF56' });
});

test('REST and MCP reject malformed codes without network calls or including the code in errors', () => {
  let requests = 0;
  const pr = new PingRoom({ token: 'agent_test', fetch: async () => { requests += 1; } });
  for (const code of ['', null, 123456789012, 'AB12-CD34-EF56', 'AB12 CD34EF56', 'ABCDEFGHIJK', 'ABCDEFGHIJKLM', 'abcdefghijß']) {
    for (const call of [() => pr.redeemCode(code), () => pr.mcp.redeemCode(code)]) {
      assert.throws(call, (error) => error instanceof PingRoomError && error.code === 'invalid_request'
        && error.message === 'The code must contain exactly 12 letters or digits.');
    }
  }
  assert.equal(requests, 0);
});

test('redemption preserves API error status and does not retry a single-use mutation', async () => {
  for (const [status, body] of [
    [403, { code: 'insufficient_scope', message: 'Reconnect to redeem codes.' }],
    [422, { message: 'The code has already been redeemed.', errors: { code: ['Already redeemed.'] } }],
    [429, { message: 'Too many attempts.' }],
  ]) {
    let requests = 0;
    const pr = new PingRoom({ token: 'agent_test', fetch: async () => {
      requests += 1;
      return new Response(JSON.stringify(body), { status });
    } });
    await assert.rejects(pr.redeemCode('AB12CD34EF56'), (error) => {
      assert.equal(error.status, status);
      assert.deepEqual(error.body, body);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test('MCP redemption initializes then calls redeem_code with the normalized code', async () => {
  const calls = [];
  const toolResult = { content: [{ type: 'text', text: JSON.stringify(result) }] };
  const pr = new PingRoom({ token: 'agent_test', fetch: async (_url, init) => {
    const envelope = JSON.parse(init.body);
    calls.push({ envelope, headers: init.headers });
    if (envelope.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: envelope.id, result:
      envelope.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'PingRoom', version: '1' } }
        : toolResult,
    }));
  } });
  assert.deepEqual(await pr.mcp.redeemCode(' ab12cd34ef56 '), toolResult);
  assert.deepEqual(calls.map(({ envelope }) => envelope.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.deepEqual(calls[2].envelope.params, { name: 'redeem_code', arguments: { code: 'AB12CD34EF56' } });
  assert.ok(calls.every(({ headers }) => headers.Authorization === 'Bearer agent_test'));
});
