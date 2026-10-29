import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomError, PingRoomTimeoutError } from '../dist/index.js';
import { recorder } from './helpers.mjs';

test('auth.startPairing leaves the full grant to the server, even for legacy scope callers', async () => {
  const scopes = ['pingroom:rooms:read', 'pingroom:broadcast:send'];
  const { calls, fetchMock } = recorder({
    'POST /api/agent/auth': () => ({
      status: 201,
      body: {
        credential: 'pending_token',
        credential_type: 'preclaim',
        expires_in: 900,
        scopes,
      },
    }),
    'POST /api/agent/auth/pair/start': () => ({
      status: 201,
      body: {
        flow_version: 2,
        claim_mode: 'agent_identity',
        agent: {
          id: 'agent-1',
          label: 'Deploy bot',
          handle: 'agt_deploy',
          profile: {
            display_name: 'Deploy bot',
            handle: 'agt_deploy',
            avatar_id: 'bot-7',
            avatar_url: 'https://api.pingroom.io/avatars/bot-7.png',
          },
        },
        pair_token: 'pair_123',
        pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
        pair_browser_url: 'https://api.pingroom.io/pair?token=pair_123',
        pair_qr_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
        app_install_url: 'https://pingroom.io/i',
        expires_in: 900,
        poll_interval_ms: 1500,
      },
    }),
  });
  const pr = new PingRoom({ fetch: fetchMock });

  const pairing = await pr.auth.startPairing({ agent_label: 'Deploy bot', scopes });

  assert.equal(pairing.pair_token, 'pair_123');
  assert.equal(pairing.pair_url, 'https://pingroom.io/app/agents/pair?token=pair_123');
  assert.equal(pairing.pair_browser_url, 'https://api.pingroom.io/pair?token=pair_123');
  assert.equal(pairing.pair_qr_url, 'https://pingroom.io/app/agents/pair?token=pair_123');
  assert.equal(pairing.app_install_url, 'https://pingroom.io/i');
  assert.equal(pairing.flow_version, 2);
  assert.equal(pairing.claim_mode, 'agent_identity');
  assert.equal(pairing.agent.profile.handle, 'agt_deploy');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    type: 'anonymous',
    agent_label: 'Deploy bot',
  });
  assert.equal(calls[0].init.headers['Authorization'], undefined);
  assert.deepEqual(JSON.parse(calls[1].init.body), {});
  assert.equal(calls[1].init.headers['Authorization'], 'Bearer pending_token');
});

test('auth.startPairing restores an existing credential when pair creation fails', async () => {
  const { fetchMock } = recorder({
    'POST /api/agent/auth': () => ({
      status: 201,
      body: {
        credential: 'pending_token',
        credential_type: 'pre_claim',
        expires_in: 900,
        scopes: ['pingroom:rooms:read'],
      },
    }),
    'POST /api/agent/auth/pair/start': () => ({
      status: 503,
      body: { code: 'temporarily_unavailable', message: 'Try again.' },
    }),
  });
  const pr = new PingRoom({ token: 'existing_active', fetch: fetchMock });

  await assert.rejects(
    () => pr.auth.startPairing({ scopes: ['pingroom:rooms:read'] }),
    (e) => e instanceof PingRoomError && e.status === 503,
  );
  assert.equal(pr.getToken(), 'existing_active');
});

test('auth.startPairing sends no client scope contract when scopes are omitted', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/auth': () => ({
      status: 201,
      body: {
        credential: 'pending_token',
        credential_type: 'pre_claim',
        expires_in: 900,
        scopes: [],
      },
    }),
    'POST /api/agent/auth/pair/start': () => ({
      status: 201,
      body: {
        pair_token: 'pair_123',
        pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
        expires_in: 900,
        poll_interval_ms: 1500,
      },
    }),
  });
  const pr = new PingRoom({ fetch: fetchMock });

  await pr.auth.startPairing();

  assert.deepEqual(JSON.parse(calls[0].init.body), { type: 'anonymous' });
  assert.deepEqual(JSON.parse(calls[1].init.body), {});
});

test('auth.waitForPairing adopts the approved credential and selected room', async () => {
  let statusCalls = 0;
  const { calls, fetchMock } = recorder({
    'POST /api/agent/auth': () => ({
      status: 201,
      body: {
        credential: 'pending_token',
        credential_type: 'preclaim',
        expires_in: 900,
        scopes: ['pingroom:rooms:read'],
      },
    }),
    'POST /api/agent/auth/pair/start': () => ({
      status: 201,
      body: {
        pair_token: 'pair_123',
        pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
        expires_in: 10,
        poll_interval_ms: 1000,
      },
    }),
    'GET /api/agent/auth/pair/status': () => {
      statusCalls += 1;
      if (statusCalls === 1) return { body: { status: 'pending' } };
      return {
        body: {
          status: 'active',
          flow_version: 2,
          claim_mode: 'agent_identity',
          credential: 'active_token',
          credential_type: 'active',
          expires_in: 0,
          scopes: ['pingroom:rooms:read'],
          handle: 'agt_deploy',
          room: { invite_code: 'AB12CD', name: 'Deployments' },
          home_room: { invite_code: 'AB12CD', name: 'Deployments' },
          owner: { name: 'Ada' },
          agent: {
            id: 'agent-1',
            label: 'Deploy bot',
            handle: 'agt_deploy',
            profile: {
              display_name: 'Deploy bot',
              handle: 'agt_deploy',
              avatar_id: 'bot-7',
              avatar_url: 'https://api.pingroom.io/avatars/bot-7.png',
            },
          },
          room_membership: {
            status: 'active',
            joined_at: '2026-09-03T08:00:00Z',
            removed_at: null,
            room: { invite_code: 'AB12CD', name: 'Deployments' },
          },
          links: {
            latest_pings: 'https://api.pingroom.io/api/agent/notifications?limit=25&page=1',
            install_app: 'https://pingroom.io/i',
          },
        },
      };
    },
    'GET /api/agent/rooms': () => ({ body: [] }),
  });
  const pr = new PingRoom({ fetch: fetchMock });
  const pairing = await pr.auth.startPairing({ scopes: ['pingroom:rooms:read'] });

  const active = await pr.auth.waitForPairing(pairing);
  await pr.rooms.list();

  assert.equal(active.credential, 'active_token');
  assert.equal(active.room.invite_code, 'AB12CD');
  assert.equal(active.home_room.invite_code, 'AB12CD');
  assert.equal(active.agent.profile.display_name, 'Deploy bot');
  assert.equal(active.owner.name, 'Ada');
  assert.equal(active.room_membership.status, 'active');
  assert.equal(Object.hasOwn(active, 'scopes'), false);
  assert.deepEqual(active.links, {
    latest_pings: 'https://api.pingroom.io/api/agent/notifications?limit=25&page=1',
    install_app: 'https://pingroom.io/i',
  });
  assert.equal(pr.getToken(), 'active_token');
  assert.equal(calls.at(-1).init.headers['Authorization'], 'Bearer active_token');
});

test('auth.waitForPairing tolerates an all-rooms grant with no eligible delivery room', async () => {
  // New servers choose an eligible private room when possible, but null remains
  // valid for accounts without one and for old server responses.
  const { calls, fetchMock } = recorder({
    'GET /api/agent/auth/pair/status': () => ({
      body: {
        status: 'active',
        credential: 'active_token',
        credential_type: 'active',
        expires_in: 0,
        scopes: ['pingroom:rooms:read'],
        handle: 'agt_deploy',
        account: { name: 'Ada' },
        room: null,
        room_access: 'all',
        rooms: [],
      },
    }),
    'GET /api/agent/rooms': () => ({ body: [] }),
  });
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

  const active = await pr.auth.waitForPairing({
    pair_token: 'pair_123',
    pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
    expires_in: 10,
    poll_interval_ms: 1000,
  });
  await pr.rooms.list();

  assert.equal(active.credential, 'active_token');
  assert.equal(active.room, null);
  assert.equal(active.room_access, 'all');
  assert.deepEqual(active.rooms, []);
  assert.equal(active.handle, 'agt_deploy');
  assert.equal(active.status, undefined);
  // setToken ran: the credential is adopted, not merely returned.
  assert.equal(pr.getToken(), 'active_token');
  assert.equal(calls.at(-1).init.headers['Authorization'], 'Bearer active_token');
});

test('auth.waitForPairing accepts an omitted room and carries the selected grant', async () => {
  const { fetchMock } = recorder({
    // `room` absent entirely, not just null.
    'GET /api/agent/auth/pair/status': () => ({
      body: {
        status: 'active',
        credential: 'active_token',
        credential_type: 'active',
        expires_in: null,
        scopes: ['pingroom:rooms:read'],
      },
    }),
  });
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

  const active = await pr.auth.waitForPairing({
    pair_token: 'pair_123',
    pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
    expires_in: 10,
    poll_interval_ms: 1000,
  });

  assert.equal(active.room, undefined);
  assert.equal(pr.getToken(), 'active_token');
});

test('auth.waitForPairing tolerates old servers and drops malformed latest-pings links', async () => {
  const malformed = [
    undefined,
    {},
    { latest_pings: '' },
    { latest_pings: '/api/agent/notifications' },
    { latest_pings: 'javascript:alert(1)' },
    { latest_pings: 'https://secret@api.pingroom.io/pings' },
    { latest_pings: 'https://api.pingroom.io/pings\u001b[2J' },
  ];

  for (const links of malformed) {
    const body = {
      status: 'active',
      credential: 'active_token',
      credential_type: 'active',
      expires_in: 0,
      scopes: ['pingroom:rooms:read'],
      room: null,
      ...(links === undefined ? {} : { links }),
    };
    const { fetchMock } = recorder({
      'GET /api/agent/auth/pair/status': () => ({ body }),
    });
    const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });
    const active = await pr.auth.waitForPairing({
      pair_token: 'pair_123',
      pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
      expires_in: 10,
      poll_interval_ms: 1000,
    });

    assert.equal(active.links, undefined);
    assert.equal(pr.getToken(), 'active_token');
  }
});

test('auth.waitForPairing drops an unsafe install link without losing latest pings', async () => {
  const { fetchMock } = recorder({
    'GET /api/agent/auth/pair/status': () => ({
      body: {
        status: 'active',
        credential: 'active_token',
        credential_type: 'active',
        expires_in: 0,
        room: null,
        links: {
          latest_pings: 'https://api.pingroom.io/api/agent/notifications?limit=25&page=1',
          install_app: 'javascript:alert(1)',
        },
      },
    }),
  });
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

  const active = await pr.auth.waitForPairing({
    pair_token: 'pair_123',
    pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
    expires_in: 10,
    poll_interval_ms: 1000,
  });

  assert.deepEqual(active.links, {
    latest_pings: 'https://api.pingroom.io/api/agent/notifications?limit=25&page=1',
  });
});

test('auth.waitForPairing accepts a server-owned grant without scope metadata', async () => {
  const { fetchMock } = recorder({
    'GET /api/agent/auth/pair/status': () => ({
      body: {
        status: 'active',
        credential: 'active_token',
        credential_type: 'active',
        expires_in: 0,
        room: null,
        room_access: 'all',
        rooms: [],
      },
    }),
  });
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

  const active = await pr.auth.waitForPairing({
    pair_token: 'pair_123',
    pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
    expires_in: 10,
    poll_interval_ms: 1000,
  });

  assert.equal(active.credential, 'active_token');
  assert.equal(Object.hasOwn(active, 'scopes'), false);
  assert.equal(pr.getToken(), 'active_token');
});

test('auth.waitForPairing still rejects a room that is present but malformed', async () => {
  for (const room of [{ name: 'Deployments' }, { invite_code: '   ' }, { invite_code: 7 }]) {
    const { fetchMock } = recorder({
      'GET /api/agent/auth/pair/status': () => ({
        body: {
          status: 'active',
          credential: 'active_token',
          credential_type: 'active',
          expires_in: 0,
          scopes: ['pingroom:rooms:read'],
          room,
        },
      }),
    });
    const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

    await assert.rejects(
      () => pr.auth.waitForPairing({
        pair_token: 'pair_123',
        pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
        expires_in: 10,
        poll_interval_ms: 1000,
      }),
      (e) => e instanceof PingRoomError && e.code === 'pairing_invalid_response',
    );
    assert.equal(pr.getToken(), 'pending_token');
  }
});

test('auth.waitForPairing reports an expired app link without changing the token', async () => {
  const { fetchMock } = recorder({
    'GET /api/agent/auth/pair/status': () => ({ body: { status: 'expired' } }),
  });
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

  await assert.rejects(
    () => pr.auth.waitForPairing({
      pair_token: 'pair_123',
      pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
      expires_in: 10,
      poll_interval_ms: 1000,
    }),
    (e) => e instanceof PingRoomError && e.code === 'pairing_expired',
  );
  assert.equal(pr.getToken(), 'pending_token');
});

test('auth.waitForPairing distinguishes late bearer expiry from early auth failures', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  for (const status of [401, 403, 404]) {
    for (const elapsed of [1000, 600_000]) {
      now = 1_000_000;
      const { fetchMock } = recorder({
        'GET /api/agent/auth/pair/status': () => {
          now += elapsed;
          return { status, body: { code: 'invalid_credential', message: 'Credential expired' } };
        },
      });
      const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });
      await assert.rejects(
        () => pr.auth.waitForPairing({ pair_token: 'pair', pair_url: 'https://pingroom.io/pair', expires_in: 900 }),
        (error) => error instanceof PingRoomError
          && error.code === (elapsed < 450_000 ? 'invalid_credential' : 'pairing_expired'),
      );
      assert.equal(pr.getToken(), 'pending_token');
    }
  }
});

test('auth.waitForPairing rejects an incomplete active response without adopting it', async () => {
  const { fetchMock } = recorder({
    'GET /api/agent/auth/pair/status': () => ({
      body: {
        status: 'active',
        credential: '',
        credential_type: 'active',
        expires_in: null,
        scopes: ['pingroom:rooms:read'],
        room: null,
      },
    }),
  });
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

  await assert.rejects(
    () => pr.auth.waitForPairing({
      pair_token: 'pair_123',
      pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
      expires_in: 10,
      poll_interval_ms: 1000,
    }),
    (e) => e instanceof PingRoomError && e.code === 'pairing_invalid_response',
  );
  assert.equal(pr.getToken(), 'pending_token');
});

test('auth.waitForPairing rejects invalid active credential metadata', async () => {
  const { fetchMock } = recorder({
    'GET /api/agent/auth/pair/status': () => ({
      body: {
        status: 'active',
        credential: 'preclaim_token',
        credential_type: 'pre_claim',
        expires_in: 'never',
        scopes: 'pingroom:rooms:read',
        room: { invite_code: 'AB12CD', name: 'Deployments' },
      },
    }),
  });
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

  await assert.rejects(
    () => pr.auth.waitForPairing({
      pair_token: 'pair_123',
      pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
      expires_in: 10,
      poll_interval_ms: 1000,
    }),
    (e) => e instanceof PingRoomError && e.code === 'pairing_invalid_response',
  );
  assert.equal(pr.getToken(), 'pending_token');
});

test('auth.waitForPairing does not adopt a credential after cancellation during a status poll', async () => {
  let releaseStatus;
  const statusGate = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  const fetchMock = async (url) => {
    if (new URL(url).pathname !== '/api/agent/auth/pair/status') {
      return new Response('{}', { status: 404 });
    }
    await statusGate;
    return new Response(JSON.stringify({
      status: 'active',
      credential: 'active_token',
      credential_type: 'active',
      expires_in: null,
      scopes: ['pingroom:rooms:read'],
      room: { invite_code: 'AB12CD', name: 'Deployments' },
    }));
  };
  const controller = new AbortController();
  const cancelled = new Error('pairing cancelled');
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });
  const waiting = pr.auth.waitForPairing({
    pair_token: 'pair_123',
    pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
    expires_in: 10,
    poll_interval_ms: 1000,
  }, { signal: controller.signal });

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(cancelled);
  releaseStatus();

  await assert.rejects(waiting, (e) => e === cancelled);
  assert.equal(pr.getToken(), 'pending_token');
});

test('auth.waitForPairing retries a timed-out status poll', async () => {
  let statusCalls = 0;
  const fetchMock = async (url) => {
    if (new URL(url).pathname !== '/api/agent/auth/pair/status') {
      return new Response('{}', { status: 404 });
    }
    statusCalls += 1;
    if (statusCalls === 1) {
      throw new PingRoomTimeoutError();
    }
    return new Response(JSON.stringify({
      status: 'active',
      credential: 'active_token',
      credential_type: 'active',
      expires_in: null,
      scopes: ['pingroom:rooms:read'],
      room: { invite_code: 'AB12CD', name: 'Deployments' },
    }));
  };
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });

  const active = await pr.auth.waitForPairing({
    pair_token: 'pair_123',
    pair_url: 'https://pingroom.io/app/agents/pair?token=pair_123',
    expires_in: 3,
    poll_interval_ms: 1000,
  });

  assert.equal(statusCalls, 2);
  assert.equal(active.credential, 'active_token');
  assert.equal(pr.getToken(), 'active_token');
});

// --- SD-05: a re-pairing that never completes puts the working credential back ---

/**
 * A client that already holds WORKING and re-pairs. The status route answers
 * from `statuses`; every call is recorded with the bearer it carried.
 */
function repairing({ statuses, pairToken = 'pair_re' } = {}) {
  const bearers = [];
  let polls = 0;
  const fetchMock = async (url, init) => {
    const path = new URL(url).pathname;
    bearers.push(`${init.method} ${path} ${init.headers.Authorization ?? '-'}`);
    if (path === '/api/agent/auth') {
      return new Response(JSON.stringify({ credential: `PENDING-${bearers.length}`, credential_type: 'pre_claim', expires_in: 900, scopes: [] }), { status: 201 });
    }
    if (path === '/api/agent/auth/pair/start') {
      return new Response(JSON.stringify({
        pair_token: pairToken,
        pair_url: `https://pingroom.io/app/agents/pair?token=${pairToken}`,
        expires_in: 900,
        poll_interval_ms: 1000,
      }), { status: 201 });
    }
    if (path === '/api/agent/auth/pair/status') {
      const next = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      return new Response(JSON.stringify(next));
    }
    if (path === '/api/agent/rooms') return new Response('[]');
    return new Response('{}', { status: 404 });
  };
  return { bearers, pr: new PingRoom({ token: 'WORKING', fetch: fetchMock }) };
}

test('an expired re-pairing puts the previous working credential back', async () => {
  const { bearers, pr } = repairing({ statuses: [{ status: 'expired' }] });
  const pairing = await pr.auth.startPairing();
  assert.match(pr.getToken(), /^PENDING-/);

  await assert.rejects(
    () => pr.auth.waitForPairing(pairing),
    (e) => e instanceof PingRoomError && e.code === 'pairing_expired',
  );

  assert.equal(pr.getToken(), 'WORKING');
  await pr.rooms.list();
  assert.equal(bearers.at(-1), 'GET /api/agent/rooms Bearer WORKING');
});

test('an aborted re-pairing restores the working credential, and a later wait resumes the same pairing', async () => {
  const { bearers, pr } = repairing({
    statuses: [
      { status: 'pending' },
      { status: 'active', credential: 'ACTIVE', credential_type: 'active', expires_in: null, scopes: [], room: null },
    ],
  });
  const pairing = await pr.auth.startPairing();
  const pending = pr.getToken();

  const controller = new AbortController();
  const cancelled = new Error('stop waiting');
  const waiting = pr.auth.waitForPairing(pairing, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(cancelled);
  await assert.rejects(waiting, (e) => e === cancelled);
  assert.equal(pr.getToken(), 'WORKING');

  // The pairing itself is still live: waiting again polls with the pending
  // credential and adopts the approval.
  const active = await pr.auth.waitForPairing(pairing);
  assert.equal(active.credential, 'ACTIVE');
  assert.equal(pr.getToken(), 'ACTIVE');
  const polls = bearers.filter((line) => line.startsWith('GET /api/agent/auth/pair/status'));
  assert.ok(polls.length >= 2);
  for (const line of polls) assert.equal(line.endsWith(`Bearer ${pending}`), true, line);
});

test('a pairing that expires after an abort leaves a fresh client without a token', async () => {
  const bearers = [];
  const fetchMock = async (url, init) => {
    const path = new URL(url).pathname;
    bearers.push(init.headers.Authorization ?? '-');
    if (path === '/api/agent/auth') return new Response(JSON.stringify({ credential: 'PENDING', credential_type: 'pre_claim', expires_in: 900, scopes: [] }), { status: 201 });
    if (path === '/api/agent/auth/pair/start') return new Response(JSON.stringify({ pair_token: 'p1', pair_url: 'https://pingroom.io/p', expires_in: 900, poll_interval_ms: 1000 }), { status: 201 });
    return new Response(JSON.stringify({ status: 'expired' }));
  };
  const pr = new PingRoom({ fetch: fetchMock });
  const pairing = await pr.auth.startPairing();
  assert.equal(pr.getToken(), 'PENDING');
  await assert.rejects(() => pr.auth.waitForPairing(pairing), (e) => e.code === 'pairing_expired');
  assert.equal(pr.getToken(), null);
});

test('a second pairing falls back to the credential beneath the first, not the first pending one', async () => {
  let registered = 0;
  const fetchMock = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/api/agent/auth') {
      registered += 1;
      return new Response(JSON.stringify({ credential: `PENDING-${registered}`, credential_type: 'pre_claim', expires_in: 900, scopes: [] }), { status: 201 });
    }
    if (path === '/api/agent/auth/pair/start') {
      return new Response(JSON.stringify({ pair_token: `p${registered}`, pair_url: 'https://pingroom.io/p', expires_in: 900, poll_interval_ms: 1000 }), { status: 201 });
    }
    return new Response(JSON.stringify({ status: 'expired' }));
  };
  const pr = new PingRoom({ token: 'WORKING', fetch: fetchMock });
  await pr.auth.startPairing();
  const second = await pr.auth.startPairing();
  assert.equal(pr.getToken(), 'PENDING-2');
  await assert.rejects(() => pr.auth.waitForPairing(second), (e) => e.code === 'pairing_expired');
  assert.equal(pr.getToken(), 'WORKING');
});

test('waiting on a pairing this client did not start leaves the token alone', async () => {
  const { fetchMock } = recorder({
    'GET /api/agent/auth/pair/status': () => ({ body: { status: 'expired' } }),
  });
  const pr = new PingRoom({ token: 'pending_token', fetch: fetchMock });
  await assert.rejects(
    () => pr.auth.waitForPairing({ pair_token: 'someone-elses', pair_url: 'https://pingroom.io/p', expires_in: 10, poll_interval_ms: 1000 }),
    (e) => e.code === 'pairing_expired',
  );
  assert.equal(pr.getToken(), 'pending_token');
});
