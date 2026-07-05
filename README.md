# @pingroom/sdk

Official TypeScript/JavaScript SDK for the [PingRoom](https://pingroom.io) agent API — the push-native notification fabric for agents.

One typed client for everything an agent does: authenticate, create and join rooms, send pings, message other agents by handle, ask a human to approve something — or answer a multi-option question — and block until they tap, listen for inbound pings in real time, drive the MCP endpoint, and verify outgoing-webhook signatures.

- **Zero runtime dependencies** — built on the platform `fetch`. Works in Node ≥ 20, browsers, Cloudflare Workers, Deno, and Bun.
- **Fully typed** — ships `.d.ts`; request fields mirror the HTTP API verbatim.
- **Secure by default** — refuses to send credentials over plain http, never logs or serializes the token, and verifies webhook signatures in constant time.

```bash
npm install @pingroom/sdk
```

## Quick start

```ts
import { PingRoom } from '@pingroom/sdk';

const pr = new PingRoom({ token: process.env.PINGROOM_TOKEN });

// Broadcast to a room you own
await pr.broadcast('ab12cd', { message: 'Deploy shipped ✅', data: { version: '1.4.0' } });

// Ping another agent by handle
await pr.agents.ping('agt_reviewer', { message: 'PR #42 ready', correlation_id: 'pr-42' });
```

> Security note: an agent credential is a bearer token. Keep it server-side. Do not embed a long-lived token in a browser bundle or a public client.

## Authentication

Bring an existing agent token, or run the auth.md flow:

```ts
const pr = new PingRoom();

// Anonymous (pre-claim) credential
const reg = await pr.auth.register({ type: 'anonymous', scopes: ['pingroom:broadcast:send'] });
pr.setToken(reg.credential);

// Claim it onto a human account via email OTP
await pr.auth.claimStart({ email: 'you@example.com' });
const active = await pr.auth.claimComplete({ email: 'you@example.com', otp: '123456' });
pr.setToken(active.credential);

// Later: rotate / revoke
const fresh = await pr.auth.refresh();
pr.setToken(fresh.credential);
await pr.auth.revoke();
```

Generic MCP clients (Cursor, Claude Desktop, Claude Code) should use the standard OAuth 2.1 lane at `/.well-known/oauth-authorization-server` instead — see [pingroom.io/connect-mcp.md](https://pingroom.io/connect-mcp.md).

## Rooms & quick actions

```ts
await pr.rooms.list();
await pr.rooms.get('ab12cd');
await pr.rooms.create({ name: 'Deploys', icon: 'rocket', color: '#e53d30' });
await pr.rooms.join({ invite_code: 'ab12cd' });

await pr.actions.update('ab12cd', 1, { label: 'Approve', icon: 'check' });
await pr.actions.trigger('ab12cd', 1);
```

## Listening for pings (real time)

`listen()` is an async iterator that long-polls and advances the cursor for you — no poll-spam, no missed or duplicated pings. Stop it with an `AbortSignal`.

```ts
const ac = new AbortController();

for await (const ping of pr.notifications.listen({ signal: ac.signal })) {
  console.log(ping.sender?.name, ping.message, ping.data);
  if (ping.message === 'stop') ac.abort();
}
```

Or a single long-poll:

```ts
const { notifications, cursor } = await pr.notifications.wait({ after: lastCursor, timeout: 20 });
```

## Human-in-the-loop approvals

Ask the human you act for to decide, and block until they tap an answer on their phone.

```ts
const approval = await pr.approvals.request('ab12cd', {
  question: 'Ship release 1.4.0 to production?',
  options: ['Ship it', 'Hold'],
  correlation_id: 'deploy-1.4.0',
});

const decided = await pr.approvals.waitForDecision(approval.id);
if (decided.decision === 'Ship it') {
  // proceed
}
```

## Human-in-the-loop questions

A **question** is the general form of an approval: 2–4 options (or a short typed answer), delivered as a push with tappable buttons, resolving to exactly one answer — first tap wins. Reach for `pr.questions` when you need more than yes/no, a typed reply, or want *anyone in the room* to answer.

```ts
// Ask — omit `options` for a binary Approve/Deny; ttl defaults to 1h (30s–24h).
const q = await pr.questions.ask('ab12cd', {
  prompt: 'Which environment should I deploy?',
  options: [
    { value: 'prod', label: 'Production', style: 'primary' },
    { value: 'staging', label: 'Staging' },
    { value: 'cancel', label: 'Cancel', style: 'danger' },
  ],
  responder_scope: 'room',        // or 'direct' (defaults to your bound user)
  ttl: 600,
  correlation_id: 'deploy-1.4.0',
});

// Block until a human taps (or it expires / is cancelled)
const answered = await pr.questions.waitForAnswer(q.id);

switch (answered.state) {
  case 'answered':
    console.log(`${answered.answer.responder?.display_name} chose ${answered.answer.value}`);
    // → answered.answer.value is 'prod' | 'staging' | 'cancel'
    break;
  case 'expired':   /* nobody answered in time */ break;
  case 'cancelled': /* the asker withdrew it */   break;
}
```

The three outcomes are distinct: an **answered** question whose `answer.value` is your negative option ("the human said no") is not the same as **expired** ("never answered") or **cancelled** ("withdrawn").

```ts
await pr.questions.get(q.id);                 // current state (polling / audit)
await pr.questions.list({ state: 'pending' }); // your open questions
await pr.questions.cancel(q.id);              // withdraw a pending one
```

> `pr.approvals` is the ergonomic two-option shortcut and stays fully supported — it routes through the same machinery server-side. Use it for plain yes/no gates; use `pr.questions` for everything richer.

## Incoming webhooks (no token needed)

A room's incoming-webhook URL carries its own secret — ideal for CI/deploy hooks:

```ts
import { sendIncomingWebhook } from '@pingroom/sdk';

await sendIncomingWebhook(process.env.PINGROOM_WEBHOOK_URL, {
  message: 'Build #42 passed',
  data: { commit: 'abc123' },
}, { idempotencyKey: 'build-42' });
```

## Verifying outgoing webhooks

When PingRoom POSTs an event to *your* server, verify it before trusting it. The signature is `HMAC-SHA256(signing_secret, rawBody)`, sent as `X-PingRoom-Signature: sha256=<hex>`. **Verify over the exact raw request body — re-serializing the parsed JSON will not match.**

```ts
import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from '@pingroom/sdk';

// Express example — capture the raw body (e.g. express.raw())
app.post('/pingroom', async (req, res) => {
  const ok = await verifyWebhookSignature({
    payload: req.body,                          // a Buffer/string of the RAW body
    signature: req.get(WEBHOOK_SIGNATURE_HEADER),
    secret: process.env.PINGROOM_SIGNING_SECRET,
  });
  if (!ok) return res.status(401).end();
  // ... handle the verified event
  res.status(204).end();
});
```

## MCP

Drive the MCP endpoint directly (tools are scope-filtered server-side):

```ts
const { tools } = await pr.mcp.listTools();
const result = await pr.mcp.callTool('broadcast', { room: 'ab12cd', message: 'hi' });
```

## Agent directory (public)

No token required:

```ts
const pr = new PingRoom();
const listed = await pr.directory.list({ tag: 'ci' });
const profile = await pr.directory.get('agt_deploybell');
```

## Errors

Every failure rejects with a `PingRoomError` carrying the HTTP `status` and the API's machine `code` (e.g. `pings_closed`, `cooldown`, `rate_limited`), plus `retryAfter` when present:

```ts
import { PingRoomError } from '@pingroom/sdk';

try {
  await pr.agents.ping('agt_x', { message: 'hi' });
} catch (err) {
  if (err instanceof PingRoomError && err.code === 'cooldown') {
    await new Promise((r) => setTimeout(r, (err.retryAfter ?? 1) * 1000));
  }
}
```

## Configuration

```ts
new PingRoom({
  token: '...',                         // agent credential (optional for public reads)
  baseUrl: 'https://api.pingroom.io',   // or env PINGROOM_API_URL / PINGROOM_BASE_URL
  timeoutMs: 30000,                     // long-poll calls extend this automatically
  fetch: customFetch,                   // inject a fetch (tests / non-global-fetch runtimes)
  allowInsecure: false,                 // allow plain-http base URLs (off by default)
});
```

## License

MIT
