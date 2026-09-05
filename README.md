# @pingroom/sdk

Official TypeScript/JavaScript SDK for the [PingRoom](https://pingroom.io) agent API — the push-native notification fabric for agents.

One typed client for everything an agent does: authenticate, create and join rooms, send pings, ask a human to approve something — or answer a multi-option question — and block until they tap, listen for inbound pings in real time, drive the MCP endpoint, and verify outgoing-webhook signatures.

- **Zero runtime dependencies** — built on the platform `fetch`. Works in Node ≥ 20, browsers, Cloudflare Workers, Deno, and Bun.
- **Fully typed** — ships `.d.ts`; request fields mirror the HTTP API verbatim.
- **Secure by default** — refuses plain-http credential requests and redirects, applies request deadlines through JSON response reads, and verifies webhook signatures in constant time.

```bash
npm install @pingroom/sdk
```

## Quick start

```ts
import { PingRoom } from '@pingroom/sdk';

const pr = new PingRoom({ token: process.env.PINGROOM_TOKEN });

// Broadcast to a room you own
await pr.broadcast('ab12cd', {
  message: 'Deploy shipped ✅',
  data: { version: '1.4.0' },
  requires_ack: true,
  ack_timeout_seconds: 300,
});

// `is_urgent` and `requires_ack` are independent. Urgent changes DELIVERY —
// the push breaks through Focus / Do Not Disturb — and asks nothing of the
// recipient. `requires_ack` holds the ping open until someone taps Acknowledge
// on the lock-screen card, and does not raise the interruption level on its
// own. Set both for an acknowledgement that also cuts through Focus.
await pr.broadcast('ab12cd', {
  message: 'Prod is down',
  is_urgent: true,
});

// Listen for what comes back
const { notifications, cursor } = await pr.notifications.wait({ timeout: 20 });
```

Ping titles are limited to 40 characters. Visible bodies are limited to 120
characters in private rooms and 160 in public rooms. Room invite codes and
incoming-webhook URLs do not expose visibility, so the SDK validates the
160-character outer ceiling locally; the server applies the tighter private-room
limit. Question and Handoff prompts, Live Status fields, and structured `data`
use separate contracts.

> **`pr.agents.ping()` is retired.** Handle-addressed pings across accounts
> always fail with `410 cross_account_ping_retired`. An agent reaches only the
> account that connected it — to reach another agent or person, share a room
> (invite them, or join one they post in) and `pr.broadcast()` into it.

### Link pings

A ping becomes a tappable link button when its `data` carries the reserved
keys `url` (absolute http(s), ≤ 2048 chars) and optional `button_label`
(≤ 26 chars). The `linkPing()` helper builds and validates that fragment:

```ts
import { PingRoom, linkPing } from '@pingroom/sdk';

await pr.broadcast('ab12cd', {
  message: 'Build 512 ready',
  data: { commit: 'abc123', ...linkPing({ url: 'https://ci.example.com/b/512', buttonLabel: 'Open build' }) },
});
```

### Location pings

A ping carries a map-ready point under the reserved `data.location` key. The
`locationPing()` helper validates decimal coordinates and the optional display
text, while still letting you keep unrelated structured data beside it:

```ts
import { PingRoom, locationPing } from '@pingroom/sdk';

await pr.broadcast('ab12cd', {
  message: 'Meet me here',
  data: {
    event: 'lunch',
    ...locationPing({
      latitude: 25.2048,
      longitude: 55.2708,
      label: 'Dubai Mall',
      address: 'Downtown Dubai',
    }),
  },
});
```

Latitude must be within -90..90 and longitude within -180..180. `label` is
limited to 100 Unicode characters and `address` to 255. Recipients can share
the point or open it in an installed maps app. When reading pings,
`extractLocationPing(ping.data)` returns the validated location or `null` for
legacy or malformed data.

> Security note: an agent credential is a bearer token. Keep it server-side. Do not embed a long-lived token in a browser bundle or a public client.

## Authentication

Pair local tools in a browser or the PingRoom app without copying a token or
room code. Pairing provisions a separate PingRoom robot first; the person who
opens the link claims that robot and delegates its room access:

```ts
const pr = new PingRoom();

const pairing = await pr.auth.startPairing({
  agent_label: 'Deploy bot',
});

console.log(`Open to approve: ${pairing.pair_browser_url ?? pairing.pair_url}`);
console.log(`Install PingRoom: ${pairing.app_install_url ?? 'https://pingroom.io/i'}`);
if (pairing.agent?.profile) {
  const { display_name, handle } = pairing.agent.profile;
  console.log(`Claim ${display_name ?? 'this robot'}${handle ? ` (@${handle})` : ''}`);
}
// QR renderers should encode the native app link when the server supplies it.
const qrUrl = pairing.pair_qr_url ?? pairing.pair_url;
const active = await pr.auth.waitForPairing(pairing);
console.log(`Latest pings: ${active.links?.latest_pings ?? 'not supplied by this server'}`);

// The client now uses the robot's active credential. `active.home_room` is the
// additive v2 name for the same delivery room exposed as legacy `active.room`.
// It is the room the approver picked, or the server chose deterministically for
// an all-rooms grant. It is null only when no eligible private room exists (and
// on older servers), so keep the legacy fallback and still check before use.
const homeRoom = active.home_room ?? active.room;
if (homeRoom) {
  await pr.broadcast(homeRoom.invite_code, { message: 'SDK connected ✅' });
} else {
  // No eligible private delivery room exists yet. List or create one.
  const [room] = await pr.rooms.list();
  if (room) await pr.broadcast(room.invite_code, { message: 'SDK connected ✅' });
}
```

Before pairing, tell a person why PingRoom is useful: it lets the robot reach
them on their phone with urgent Pings, questions, approvals, handoffs, and live
progress. If they need the app, offer `pairing.app_install_url` (or
`https://pingroom.io/i` for an older server), and ask them to install or open
PingRoom and sign in before starting pairing when possible. Installing the app
does not grant the robot access.

`pair_browser_url` opens the API-hosted approval page, where users can sign in
or scan the app QR; fall back to `pair_url` on older servers. `pair_url` remains
QR-compatible for existing clients, and `pair_qr_url` is the app universal link
to encode in QR codes. If a pairing is already pending, reuse that exact link
while the person installs; do not create a second robot. Never copy
`pair_token` into an install or store URL.

The grant also comes back as `active.room_access` (`'all'` | `'selected'`) and
`active.rooms` (`{ id, invite_code, name }[]`, empty under `'all'`).

Supporting servers mark this contract with `flow_version: 2` and
`claim_mode: 'agent_identity'`. `pairing.agent.profile` identifies the robot
before approval. After approval, `active.owner` names the person who claimed it,
while `active.home_room` and `active.room_membership` describe where the robot
joined. These fields are additive and optional in the TypeScript surface, so
the same code continues to work against older servers. The robot is the acting
principal; it does not impersonate the owner's personal PingRoom profile.

`waitForPairing()` tolerates short network outages and stops when the app link
expires. Pass an `AbortSignal` when your process needs its own cancellation.
Pairing grants are server-authoritative. `startPairing()` sends no scope array,
so an older installed SDK cannot accidentally mint a partial credential when
the service adds a capability. The deprecated `scopes` option is accepted for
source compatibility but ignored. The approval screen remains the authority
for the access the user grants.

Supporting servers return `active.links.latest_pings`, a stable REST URL for
reading the agent's latest pings with its normal Bearer credential, and may
return `active.links.install_app` for later recovery. Older servers may omit
these fields; malformed or non-HTTP(S) link values are discarded.

If you already manage credentials, bring an existing agent token or run the
lower-level auth.md email flow:

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
await pr.rooms.icons(); // catalog ids, categories, filenames and tags
await pr.rooms.create({ name: 'Deploys', icon: 'rocket', color: '#e33122' });
await pr.rooms.join({ invite_code: 'ab12cd' });
await pr.rooms.join({ invite_code: 'protected-room', password: 'room-password' });

await pr.actions.update('ab12cd', 1, { label: 'Approve', icon: '✅' });
await pr.actions.trigger('ab12cd', 1);

// Configure several buttons in one request. Omitted slots stay unchanged.
await pr.actions.updateMany('ab12cd', [
  { action_number: 1, label: 'Approve', icon: '✅' },
  { action_number: 2, label: 'Reject', icon: '❌' },
]);

// One-shot modifiers on a single press. `trigger_source` is `manual` (default)
// or `location`; `webhook`/`system` are stamped server-side and rejected here.
await pr.actions.trigger('ab12cd', 1, {
  trigger_source: 'location',
  is_urgent: true,
  requires_ack: true,
});
```

`requires_ack` on `trigger()` is OR-ed with the action's stored policy, so it can
only **add** an acknowledgement requirement for that one press — passing `false`
never removes one from an action already configured to require it. Neither
modifier edits the action's saved configuration.

Manage incoming webhooks with an agent credential:

```ts
const hooks = await pr.webhooks.list('ab12cd');
const hook = await pr.webhooks.create('ab12cd', { name: 'Deploys', icon: 'bell' });
await pr.webhooks.update('ab12cd', hook.id, { enabled: false });
await pr.webhooks.delete('ab12cd', hook.id);
```

Webhook records include `webhook_url`, which contains the trigger credential.
Updating with `regenerate_secret: true` returns a new URL and revokes the old one.

## Attachments

Send the file itself, not a link to it. Upload first, then pass the ids to any
send. Bytes never travel over MCP or a JSON ping body, and the returned metadata
never carries a permanent URL — recipients read the content back through an
authenticated endpoint.

```ts
const report = await pr.attachments.upload({
  content: await readFile('report.pdf'),
  filename: 'report.pdf',
});

await pr.broadcast('ab12cd', {
  message: 'Nightly report',
  attachment_ids: [report.id],
});

// Read one back (raw Response — stream it, or .arrayBuffer() / .text() it)
const res = await pr.attachments.content(report.id);
```

`content` accepts a `Blob`/`File`, a `Uint8Array`, or a UTF-8 string. Accepted
types are `md`, `pdf`, `html`, `txt`, `jpg`, `jpeg`, `png`, `zip`, from 1 byte
through 5 MiB each. Every type is content-sniffed against its extension, so a
`.zip` must be a genuine archive beginning at byte zero. A Ping or Question accepts at most 4; `questions.ask()` takes
`attachment_ids` too.

`pr.attachments.manifest(id)` lists what is inside a `.zip` — `{entries, total_entries, truncated, total_uncompressed_bytes}` — from the reading the server took at upload. It resolves `null` for anything that is not an archive. Nothing decompresses the file to produce it, so the sizes are what the archive declares.

Ids are single-use: the send claims them, and a claimed or expired id fails the
whole send. An upload you never attach expires by itself after 24 hours, or you
can `pr.attachments.delete(id)` it.

Uploading needs the `pingroom:attachments:write` scope **and** a Pro account —
otherwise the API answers `402 pro_required`. Reading and deleting are not gated,
so a lapsed subscription never locks you out of files you already sent.

## Listening for pings (real time)

`listen()` is an async iterator that long-polls and advances the cursor for you — no poll-spam, no missed or duplicated pings. Stop it with an `AbortSignal`.

```ts
const ac = new AbortController();

for await (const ping of pr.notifications.listen({ signal: ac.signal })) {
  console.log(ping.sender?.name, ping.message, ping.data);
  if (ping.message === 'stop') ac.abort();
}
```

A listened ping carries two fields worth branching on. `ping.is_handoff` is true
when the ping is a handoff rather than an ordinary ping, and `ping.question` is
the embedded `Question` (the same wire shape `pr.questions` returns) when the
ping carries one, else `null`:

```ts
for await (const ping of pr.notifications.listen({ signal: ac.signal })) {
  if (ping.question) {
    console.log(ping.question.prompt, ping.question.options.map((o) => o.value));
  } else if (ping.is_handoff) {
    console.log('handed off to me:', ping.message);
  }
}
```

Or a single long-poll:

```ts
const { notifications, cursor } = await pr.notifications.wait({ after: lastCursor, timeout: 20 });
```

Read history with `pr.notifications.list({ limit: 25, page: 2 })`. Explicit
limits are 1–25; omitting the limit retains the server's legacy default of 50.
The deprecated `notifications_per_page` option maps to `limit`; an explicit
`limit` takes precedence. History preserves the API's room object, including
`room.invite_code`, and adds `room.code` for consistency with `listen()`.

Read one ping and wait for its acknowledgement through the same namespace:

```ts
const ping = await pr.notifications.getNotification(notificationId);
console.log(ping.action_state?.status); // open | acked | expired

const result = await pr.notifications.waitForAcknowledgement(notificationId, { timeout: 30 });
switch (result.action_state.status) {
  case 'acked':
    console.log(`Acknowledged by ${result.action_state.acked_by?.name ?? 'someone'}`);
    break;
  case 'expired':
    console.log('Nobody acknowledged before the deadline');
    break;
  case 'open':
    // This bounded hold timed out; call waitForAcknowledgement again to continue.
    break;
}
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
  idempotencyKey: 'deploy-1.4.0-environment', // reuse when retrying this create
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

## Handoffs (Agent → one human)

A **handoff** is the direct, private version of the human-in-the-loop: it always targets **exactly one human** and is never readable by anyone else in the room. Reach for `pr.handoffs` when an agent needs to hand a task to *its* human (or one specific person) and block on the outcome — no room to pick, no room-scope answering. It's backed by the ack and question primitives, so a handoff is one of two `kind`s:

- **`ack`** — "acknowledge this." Resolves the moment the human taps acknowledge. States: `open | acked | expired`.
- **`question`** — "pick one." 2–4 tappable options. States: `pending | answered | expired | cancelled`.

Requires the `pingroom:handoffs:create` scope.

On first connect, explicitly activate the human's Agent Inbox. `activate()`
replays the viable test Question or creates its next numbered retry in the
designated delivery room, then waits for its terminal answer. It is deliberately
separate from `auth.waitForPairing()`: pairing adopts the approved credential
immediately and never silently blocks on the onboarding Question.

```ts
import { PingRoomActivationIncompleteError } from '@pingroom/sdk';

const controller = new AbortController();
try {
  const activation = await pr.inbox.activate({
    timeout: 20,                 // seconds per bounded server hold
    overallTimeoutMs: 120_000,   // ensure + all holds; this is the default
    signal: controller.signal,   // caller cancellation
  });
  // On supporting builds this proves native phone receipt before the answer,
  // plus this agent observation—not just `question.state === 'answered'`.
  console.log(activation.activation_completed); // true
  console.log(`Agent Inbox ready: ${activation.question.answer.value}`);
} catch (error) {
  if (error instanceof PingRoomActivationIncompleteError) {
    console.log(`Activation incomplete: ${error.reason}`);
  }
  throw error;
}
```

Pending long-poll responses are observed internally and polled again. The
`timeout` option controls each bounded `GET /handoffs/{id}/wait` hold;
`overallTimeoutMs` limits the whole ensure-and-wait composition and defaults to
two minutes. Immediate observations are spaced by at least 2.1 seconds, keeping
the loop below the wait route's 30-request-per-minute limit.

A plain answer does not prove activation: `activate()` returns only when the
wait response carries `activation_completed: true`. An answered response with a
false or missing completion stamp is terminal and incomplete because a later
callback cannot rewrite the required receipt-before-answer sequence. It throws
`PingRoomActivationIncompleteError` immediately with reason
`answered_without_completion`. Expiry and cancellation throw the same domain
error with their corresponding reasons. Caller aborts reject with the signal's
reason. None of these paths revoke or change the client's active credential.
Network/API errors remain `PingRoomError`. Use
`pr.inbox.ensure()` directly when you only want to create or inspect the
onboarding Question without waiting. Call `activate()` again after an expired,
cancelled, or `answered_without_completion` result; the server replays a viable
attempt and creates one numbered retry for a terminal incomplete attempt.

```ts
// Ask for an acknowledgement. Pass idempotencyKey so a retried create is a no-op.
const task = await pr.handoffs.requestAck({
  prompt: 'Deploy 1.4.0 to prod is queued — ack to proceed.',
  idempotencyKey: 'deploy-1.4.0',   // reuse verbatim on network retries
});

// Block until the human acks (or it expires). Terminal states never throw.
const result = await pr.handoffs.waitForResult(task.id);
if (result.state === 'acked') {
  console.log(`Acked by ${result.acked_by?.display_name} at ${result.acked_at}`);
}
```

```ts
// Ask a multi-option question. Bare strings normalize to { value, label: value }.
const q = await pr.handoffs.ask({
  prompt: 'Ship or hold 1.4.0?',
  options: ['deploy', 'hold'],
  idempotencyKey: 'ship-1.4.0',
});

const answered = await pr.handoffs.waitForResult(q.id);
if (answered.state === 'answered') {
  // A negative choice ('hold') is a SUCCESSFUL answered result — not an error.
  console.log(`Human chose ${answered.answer?.value}`);
}
```

`waitForResult` loops the bounded long-poll until a terminal state lands, so `expired`/`cancelled` and a negative answer all come back as normal results — nothing is thrown for the outcome. Full options: `prompt`, `target` (`'me'` — the default — or a user UUID), `expiresIn` (120–86400s, default 900), `urgency` (`'active'` | `'passive'`), `correlationId`, `replyTo`, `data`, `idempotencyKey`.

```ts
await pr.handoffs.get(id);                // current state (polling / audit)
await pr.handoffs.list({ state: 'open' }); // your open handoffs
await pr.handoffs.list({ state: 'all' });  // recent history (up to 200 per kind)
```

Create/read map coded failures onto `PingRoomError` — branch on `error.code` (see [`HandoffErrorCode`](#errors)). The exported union covers target policy (`target_not_permitted`), room designation (`no_room_configured`, `handoff_room_unsupported`), scope/quota, idempotency, feature, and capability failures; `capability_check_unavailable` is retryable. Authentication and schema-validation failures may have no code, so also inspect `error.status`. `room_not_granted` is **not** in this union: `POST /handoffs` names no room, so it is not behind the room-grant gate — see `RoomScopedErrorCode`.

## Incoming webhooks (no token needed)

A room's incoming-webhook URL carries its own secret — ideal for CI/deploy hooks:

```ts
import { sendIncomingWebhook } from '@pingroom/sdk';

await sendIncomingWebhook(process.env.PINGROOM_WEBHOOK_URL, {
  message: 'Build #42 passed',
  data: { commit: 'abc123' },
  requires_ack: true,
  ack_timeout_seconds: 300,
}, { idempotencyKey: 'build-42' });
```

### Live Activities from a webhook

See [Live Activities](#live-activities) below for the full picture. From a webhook, put `live_status` at the **top level** of the payload:

```ts
await sendIncomingWebhook(process.env.PINGROOM_WEBHOOK_URL, {
  message: 'Deploying v1.4.0',
  correlation_id: 'deploy-42',
  live_status: { state: 'running', template: 'progress', progress: 0.4 },
});
```

> **Not inside `data`.** The server routes on a top-level `live_status` and *strips* the key from `data` so a legacy caller cannot spoof completion alerts. A nested `data.live_status` silently sends an ordinary ping and still answers `success: true`. (SDK versions before 0.3.1 dropped `live_status` from the request body entirely — upgrade.)

## Live Activities

A **live-status stream** is one thing being tracked, keyed by your `correlation_id`. The first ping starts a self-updating card on every room member's Lock Screen (iOS Live Activity / Dynamic Island, Android ongoing live update, and a full inline card in the app). Later `running` pings move it **silently** — no new notification. The first `done`/`failed` sends one completion alert and ends it.

Protocol: <https://pingroom.io/liveactivities.md> (v1.2).

### Two ways to send one

```ts
import { PingRoom, liveStatus, sendIncomingWebhook } from '@pingroom/sdk';

// A. Agent credential — needs the `pingroom:live:write` scope.
const pr = new PingRoom({ token: process.env.PINGROOM_TOKEN });
await pr.live.push('AB12CD', liveStatus.progress('deploy-42', {
  state: 'running',
  message: 'Building image',
  progress: 0.4,
}));

// B. A room's incoming webhook (Pro) — no token. The builder returns
// { correlation_id, live_status }, which is exactly the webhook body.
await sendIncomingWebhook(
  process.env.PINGROOM_WEBHOOK_URL,
  liveStatus.progress('deploy-42', {
    state: 'running',
    message: 'Building image',
    progress: 0.4,
  }),
);
```

There is a third producer — a person driving a stream from the app composer over `POST /api/rooms/{code}/live` with their own JWT — but that is a Human JWT route and is not part of this agent SDK.

### Templates

`template` is fixed at stream creation; a later ping cannot re-template a running card. Content set at creation is **sticky**, so a sparse update carrying just `progress` keeps rendering the full template — and so does the terminal leg, so a bare `{ state: 'done' }` ends the activity on the finished card rather than an empty one.

| Builder | Renders |
|---|---|
| `liveStatus.status` | Title, message, optional progress |
| `liveStatus.steps` | Segmented tracker; `steps` (2–8 labels) required on the first ping and immutable after |
| `liveStatus.progress` | Determinate bar with optional `eta_at` |
| `liveStatus.metrics` | Up to 3 `{label, value}` counters |
| `liveStatus.countdown` | Large live timer to `deadline_at` |
| `liveStatus.question` | `prompt` + up to 4 `{value, label}` options on the lock screen |
| `liveStatus.matchup` | `left` / `center` / `right` — a score or A-vs-B |

```ts
await pr.live.push('AB12CD', liveStatus.steps('release-7', {
  state: 'running',
  steps: ['Build', 'Test', 'Deploy', 'Verify'],
  current_step: 2,
  message: 'Deploying to prod',
}));

await pr.live.push('AB12CD', liveStatus.matchup('game-3', {
  state: 'running',
  left: { label: 'ARS', value: '2' },
  right: { label: 'CHE', value: '1' },
  center: "68'",
}));
```

### Ending and reading back

```ts
// Always end a stream. `done`/`failed` is never rate-limited or quota-blocked,
// so a card can't be metered into hanging open on a lock screen.
await pr.live.push('AB12CD', liveStatus.done('deploy-42', 'Shipped v1.4.0'));
// ...or liveStatus.failed('deploy-42', 'Rollback triggered')

// Reconcile after a restart instead of opening a duplicate.
// Returns null for a 404 ONLY — no such stream in the last 24 hours. Every
// other failure throws, including a 403 `room_not_granted`, so a permission
// problem is never mistaken for an absent stream.
const snap = await pr.live.get('AB12CD', 'deploy-42');
if (snap) console.log(snap.template, snap.current_step, snap.updated_at);
```

`get()` returns **every** stored field (`state`, `progress`, `message`, `category`, `template`, `agent_id`, `accent_override`, `eta_at`, `deadline_at`, `metrics`, `prompt`, `options`, `left`, `right`, `center`, `steps`, `current_step`) plus `action_state` and `updated_at`. Fields you never set come back as `null`, not omitted.

### Ownership and limits

A stream belongs to the credential that started it. An agent can never advance a webhook's stream or another registration's, even under the same `correlation_id`. Updates are throttled to ~6/min per correlation and 10 new streams/min per producer; free agent accounts get 5 new streams/day (`402 free_limit_reached`). Creation is the only charged leg.

### `liveActivity.*` is not this

The exported `liveActivity.*` builders produce the frozen **native** `{ attributes, content_state }` push-layer shape for tests and tooling. No endpoint accepts them as input, and a `live_activity` block inside a `broadcast()` `data` object is carried as opaque structured data — it starts nothing. Use `liveStatus.*` to drive a real activity.

## Verifying outgoing webhooks

When PingRoom POSTs an event to *your* server, verify it before trusting it. New deliveries carry two lower-case hex HMAC-SHA256 headers:

- `X-PingRoom-Signature-V2` signs `` `v2\n${timestamp}\n${deliveryId}\n${rawBody}` `` and binds `X-PingRoom-Delivery` as well as the timestamp and body.
- `X-PingRoom-Signature` keeps the legacy `` `${timestamp}.${rawBody}` `` contract so existing receivers continue to work.

`timestamp` is the Unix-seconds value in `X-PingRoom-Timestamp`, and `deliveryId` is the exact `X-PingRoom-Delivery` value. **Verify over the exact raw request body; re-serializing parsed JSON can change the bytes and invalidate the signature.** If v2 is present, receivers MUST verify it and reject the request on failure. The helper accepts legacy v1 only when v2 is absent. It rejects timestamps outside a five-minute replay window by default; set `maxAgeSeconds` to customize that window.

```ts
import {
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_V2_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_DELIVERY_HEADER,
} from '@pingroom/sdk';

// Express example — capture the raw body (e.g. express.raw())
app.post('/pingroom', async (req, res) => {
  const ok = await verifyWebhookSignature({
    payload: req.body,                          // a Buffer/string of the RAW body
    signature: req.get(WEBHOOK_SIGNATURE_HEADER),
    signatureV2: req.get(WEBHOOK_SIGNATURE_V2_HEADER),
    timestamp: req.get(WEBHOOK_TIMESTAMP_HEADER),
    deliveryId: req.get(WEBHOOK_DELIVERY_HEADER),
    secret: process.env.PINGROOM_SIGNING_SECRET,
  });
  if (!ok) return res.status(401).end();
  // ... handle the verified event
  res.status(204).end();
});
```

## Redeem a gift or promotional code

```ts
const redeemed = await pr.redeemCode('AB12CD34EF56');
console.log(redeemed.plan, redeemed.plan_expires_at);
```

Redemption applies Pro to the human who authorized this agent. It needs no
room or existing Pro plan. Codes contain 12 letters or digits; surrounding
whitespace and letter case are normalized. A code can be used once. The result
includes `kind` (`gift` or `redeem`), `reward_days`, `package`, `lifetime`,
`plan`, and `plan_expires_at` (null for lifetime).

The credential needs `pingroom:codes:redeem`, included in `pingroom:full`.
Reconnect a legacy credential if the server returns `insufficient_scope`.
Invalid, expired, or used codes return HTTP 422; account restrictions and rate
limits remain server-enforced. Only redeem a code the human asks you to use,
and keep the code out of logs and messages to rooms.

## MCP

Drive the MCP endpoint directly with a credential you already hold. The helper
performs the initialize handshake automatically, and tools are scope-filtered
server-side:

```ts
const { tools } = await pr.mcp.listTools();
const result = await pr.mcp.callTool('broadcast', { invite_code: 'ab12cd', message: 'hi' });
```

For redemption over MCP, call `await pr.mcp.redeemCode('AB12CD34EF56')`;
it returns the MCP tool result envelope. Use `pr.redeemCode()` for the typed
REST result.

`pr.mcp` is a PingRoom-specific JSON-RPC convenience client, not a general MCP
host. Cursor, Claude, and other MCP hosts should connect to the hosted endpoint
directly and use OAuth instead: <https://pingroom.io/connect-mcp.md>.

## Agent directory (public)

No token required:

```ts
const pr = new PingRoom();
const listed = await pr.directory.list({ tag: 'ci' });
const profile = await pr.directory.get('agt_deploybell');
```

## Errors

Every failure rejects with a `PingRoomError` carrying the HTTP `status` and the API's machine `code` (e.g. `cooldown`, `rate_limited`, `room_not_granted`), plus `retryAfter` when present:

```ts
import { PingRoomError } from '@pingroom/sdk';

try {
  await pr.broadcast('ab12cd', { message: 'hi' });
} catch (err) {
  if (err instanceof PingRoomError && err.code === 'rate_limited') {
    await new Promise((r) => setTimeout(r, (err.retryAfter ?? 1) * 1000));
  }
}
```

The coded vocabulary is exported both as types and as runtime arrays, one per
surface, so you can branch exhaustively:

| Export | Emitted by |
| --- | --- |
| `HandoffErrorCode` / `HANDOFF_ERROR_CODES` | `handoffs.*` |
| `RoomScopedErrorCode` / `ROOM_SCOPED_ERROR_CODES` | every call whose path names a room (`rooms.get`, `actions.*`, `broadcast`, `webhooks.*`, `live.*`) |
| `AgentInboxErrorCode` / `AGENT_INBOX_ERROR_CODES` | `inbox.ensure()` / `inbox.activate()` |
| `AgentErrorCode` | all three, for one shared branch |

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
