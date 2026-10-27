import test from 'node:test';
import assert from 'node:assert/strict';
import { PingRoom, PingRoomActivationIncompleteError, PingRoomError } from '../dist/index.js';
import { recorder } from './helpers.mjs';

test('inbox.ensure resolves the designated delivery room with an empty POST', async () => {
  const { calls, fetchMock } = recorder({
    'POST /api/agent/inbox/ensure': () => ({
      status: 201,
      body: {
        onboarded: true,
        replayed: false,
        room: { id: 'r-project', name: 'Project X', invite_code: 'PROJECT1', is_agent_inbox: false },
        question: { id: 'q-onboard', kind: 'question', state: 'pending', options: [] },
      },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const result = await pr.inbox.ensure();
  assert.equal(result.room.is_agent_inbox, false);
  assert.equal(result.question.id, 'q-onboard');
  assert.deepEqual(JSON.parse(calls[0].init.body), {});
});

function inboxEnsureBody(id = 'q-onboard') {
  return {
    onboarded: true,
    replayed: false,
    room: { id: 'r1', name: 'Project X', invite_code: 'PROJECT1', is_agent_inbox: false },
    question: {
      id,
      kind: 'question',
      prompt: 'PingRoom connected. Can you answer this?',
      state: 'pending',
      options: [{ value: 'yes', label: 'Yes' }],
      expires_at: '2026-08-10T00:00:00Z',
      created_at: '2026-08-09T00:00:00Z',
    },
  };
}

function answeredActivation(overrides = {}) {
  return {
    id: 'q-onboard',
    kind: 'question',
    prompt: 'PingRoom connected. Can you answer this?',
    state: 'answered',
    answer: {
      value: 'yes',
      label: 'Yes',
      text: null,
      responder: { id: 'u1', display_name: 'Mahdi' },
      answered_at: '2026-08-09T00:01:00Z',
    },
    activation_completed: true,
    ...overrides,
  };
}

test('inbox.activate throttles pending observations before confirmed success', async () => {
  let waits = 0;
  const waitStartedAt = [];
  const { calls, fetchMock } = recorder({
    'POST /api/agent/inbox/ensure': () => ({
      status: 201,
      body: inboxEnsureBody(),
    }),
    'GET /api/agent/handoffs/q-onboard/wait': () => {
      waits += 1;
      waitStartedAt.push(Date.now());
      if (waits === 1) {
        return { body: { id: 'q-onboard', kind: 'question', state: 'pending', answer: null, activation_completed: false } };
      }
      return { body: answeredActivation() };
    },
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });

  const activated = await pr.inbox.activate({ timeout: 3, overallTimeoutMs: 8_000 });

  assert.equal(activated.activation_completed, true);
  assert.equal(activated.room.invite_code, 'PROJECT1');
  assert.equal(activated.question.state, 'answered');
  assert.equal(activated.question.activation_completed, true);
  assert.equal(activated.question.answer.value, 'yes');
  assert.equal(waits, 2);
  for (let i = 1; i < waitStartedAt.length; i += 1) {
    assert.ok(waitStartedAt[i] - waitStartedAt[i - 1] >= 2_080, 'polls must stay below 30 requests/minute');
  }
  assert.equal(calls[0].init.method, 'POST');
  for (const call of calls.slice(1)) assert.equal(new URL(call.url).searchParams.get('timeout'), '3');
});

test('inbox.activate rejects answered results whose activation stamp is false or missing', async () => {
  for (const activationCompleted of [false, undefined]) {
    const terminal = answeredActivation();
    if (activationCompleted === undefined) delete terminal.activation_completed;
    else terminal.activation_completed = activationCompleted;

    let waits = 0;
    const { fetchMock } = recorder({
      'POST /api/agent/inbox/ensure': () => ({ body: inboxEnsureBody() }),
      'GET /api/agent/handoffs/q-onboard/wait': () => {
        waits += 1;
        return { body: terminal };
      },
    });
    const pr = new PingRoom({ token: 'active-token', fetch: fetchMock });
    await assert.rejects(
      () => pr.inbox.activate({ overallTimeoutMs: 100 }),
      (error) => error instanceof PingRoomActivationIncompleteError
        && error.reason === 'answered_without_completion'
        && error.code === 'inbox_activation_incomplete',
    );
    assert.equal(pr.getToken(), 'active-token');
    assert.equal(waits, 1, 'a terminal unverified sequence must not be polled as if history can change');
  }
});

test('inbox.activate maps expired onboarding to an activation-incomplete domain error', async () => {
  const { fetchMock } = recorder({
    'POST /api/agent/inbox/ensure': () => ({ body: inboxEnsureBody('q-expired') }),
    'GET /api/agent/handoffs/q-expired/wait': () => ({
      body: {
        id: 'q-expired', kind: 'question', state: 'expired', answer: null, activation_completed: false,
      },
    }),
  });
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  await assert.rejects(
    () => pr.inbox.activate({ overallTimeoutMs: 500 }),
    (error) => error instanceof PingRoomActivationIncompleteError && error.reason === 'expired',
  );
});

test('inbox.activate cancellation interrupts the handoff wait', async () => {
  const controller = new AbortController();
  const cancelled = new Error('activation cancelled');
  const fetchMock = async (url, init) => {
    if (new URL(url).pathname === '/api/agent/inbox/ensure') {
      return new Response(JSON.stringify(inboxEnsureBody()));
    }
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  const pr = new PingRoom({ token: 't', fetch: fetchMock });
  const activation = pr.inbox.activate({ signal: controller.signal, timeout: 1, overallTimeoutMs: 500 });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(cancelled);
  await assert.rejects(activation, (error) => error === cancelled);
});

test('inbox.activate enforces its overridable overall deadline without changing the credential', async () => {
  const fetchMock = async (url, init) => {
    if (new URL(url).pathname === '/api/agent/inbox/ensure') {
      return new Response(JSON.stringify(inboxEnsureBody()));
    }
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  const pr = new PingRoom({ token: 'active-token', fetch: fetchMock });
  await assert.rejects(
    () => pr.inbox.activate({ overallTimeoutMs: 20 }),
    (error) => error instanceof PingRoomActivationIncompleteError && error.reason === 'deadline_exceeded',
  );
  assert.equal(pr.getToken(), 'active-token');
});

test('inbox.activate overall deadline includes the ensure request', async () => {
  let requestedPath = null;
  const pr = new PingRoom({
    token: 'active-token',
    fetch: async (url, init) => {
      requestedPath = new URL(url).pathname;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
  });

  await assert.rejects(
    () => pr.inbox.activate({ overallTimeoutMs: 20 }),
    (error) => error instanceof PingRoomActivationIncompleteError && error.reason === 'deadline_exceeded',
  );
  assert.equal(requestedPath, '/api/agent/inbox/ensure');
  assert.equal(pr.getToken(), 'active-token');
});

test('inbox.activate rejects invalid overall deadlines before fetching', async () => {
  let fetched = false;
  const pr = new PingRoom({ token: 't', fetch: async () => ((fetched = true), new Response('{}')) });
  for (const overallTimeoutMs of [-1, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => pr.inbox.activate({ overallTimeoutMs }),
      (error) => error instanceof PingRoomError && error.code === 'invalid_request',
    );
  }
  assert.equal(fetched, false);
});

test('inbox.activate validates ensure correlation and terminal answer envelopes', async () => {
  const baseEnsure = inboxEnsureBody();
  const invalidEnsure = new PingRoom({
    token: 't',
    fetch: async () => new Response(JSON.stringify({
      ...baseEnsure,
      question: { ...baseEnsure.question, id: '' },
    })),
  });
  await assert.rejects(
    () => invalidEnsure.inbox.activate({ overallTimeoutMs: 500 }),
    (error) => error instanceof PingRoomError && error.code === 'inbox_invalid_response',
  );

  for (const terminal of [
    answeredActivation({ id: 'different-id' }),
    answeredActivation({ kind: 'ack' }),
    answeredActivation({ answer: { value: 'yes' } }),
  ]) {
    const { fetchMock } = recorder({
      'POST /api/agent/inbox/ensure': () => ({ body: inboxEnsureBody() }),
      'GET /api/agent/handoffs/q-onboard/wait': () => ({ body: terminal }),
    });
    const pr = new PingRoom({ token: 't', fetch: fetchMock });
    await assert.rejects(
      () => pr.inbox.activate({ overallTimeoutMs: 500 }),
      (error) => error instanceof PingRoomError && error.code === 'inbox_invalid_response',
    );
  }
});

test('inbox.activate propagates ensure and wait API errors', async () => {
  const ensureFailure = new PingRoom({
    token: 't',
    fetch: async () => new Response(JSON.stringify({ code: 'no_room_configured', message: 'Choose a room.' }), { status: 409 }),
  });
  await assert.rejects(
    () => ensureFailure.inbox.activate(),
    (error) => error instanceof PingRoomError && error.code === 'no_room_configured' && error.status === 409,
  );

  const { fetchMock } = recorder({
    'POST /api/agent/inbox/ensure': () => ({
      body: inboxEnsureBody(),
    }),
    'GET /api/agent/handoffs/q-onboard/wait': () => ({
      status: 503,
      body: { code: 'temporarily_unavailable', message: 'Try again.' },
    }),
  });
  const waitFailure = new PingRoom({ token: 't', fetch: fetchMock });
  await assert.rejects(
    () => waitFailure.inbox.activate({ timeout: 2, overallTimeoutMs: 500 }),
    (error) => error instanceof PingRoomError && error.code === 'temporarily_unavailable' && error.status === 503,
  );
});
