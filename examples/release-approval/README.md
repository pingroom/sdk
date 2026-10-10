# Release approval for an exact artifact

A file can change while a release job waits for a human to approve it. This
example includes the file's SHA-256 in the approval question, checks the returned
decision against that request, and refuses to run the release callback if the
file has changed. The callback receives the verified bytes directly.

The demo uses the real SDK with a simulated transport. It runs offline, needs no
account, and never reads PingRoom credentials or deploys anything. Its temporary
files are removed when it finishes.

## Run it

Requires Node.js 20 or newer. From a source checkout:

```sh
git clone https://github.com/pingroom/sdk.git
cd sdk
npm ci
npm run build
node examples/release-approval/demo.mjs approve
```

The command prints a JSON result. Each demonstrated outcome, including a blocked
release, exits with status 0; inspect `outcome` and `reason` in the JSON. Unexpected
demo failures exit nonzero. The gate itself rejects blocked releases.

Try the other scenarios with the same command:

| Scenario | What it exercises |
| --- | --- |
| `approve` | A matching affirmative decision runs the callback once. |
| `deny` | A negative decision blocks the callback. |
| `expire` | An expired approval blocks the callback. |
| `changed` | The file changes while approval is pending. |
| `cancel` | The caller cancels the wait. |
| `timeout` | No decision arrives before the local deadline. |
| `mismatch` | The returned decision belongs to different request context. |

For example:

```sh
node examples/release-approval/demo.mjs changed
```

The example files are available in this repository; they are not exported by
the npm package.

## How the gate works

`releaseWithApproval()` reads a nonempty regular file, up to 1 MiB, and hashes
its contents with SHA-256. It generates a fresh correlation ID and puts the
artifact's name, destination, and full digest in the question shown to the
approver. The request also carries that context in `data`.

The gate checks the created approval and the final response against the saved
request. A response must match the approval ID, room, correlation ID, question,
options, artifact context, and original expiry. Only `status: "decided"` with
the exact decision `"approve"` can proceed. Denial, expiry, malformed responses,
unrecognized states, cancellation, and timeouts block the callback.

After approval, the gate reads the file again and verifies its digest. It passes
that second, verified Buffer to `execute`; the callback must use those bytes
instead of reopening the path. This preserves the approved content even if the
path changes again after verification.

The default deadline is 60 seconds; `timeoutMs` accepts an integer from 1 to
300,000. It covers preparation and the approval wait and is checked before
`execute` starts. It does not limit callback duration. The callback receives an
AbortSignal and must handle cancellation itself.

## Adapt it

`gate.mjs` accepts an existing, trusted SDK client. To adapt it to real approvals,
configure that client yourself with an authorized agent token and a private
room. The demo transport always simulates decisions; it is unsuitable for a
real approval check.

```js
import { releaseWithApproval } from './examples/release-approval/gate.mjs';

// `client` is your configured PingRoom SDK client.
await releaseWithApproval({
  client,
  room: 'your-room-code',
  artifactPath: './build/release.json',
  destination: 'staging',
  timeoutMs: 120_000,
  execute: async ({ bytes, sha256, signal }) => {
    signal.throwIfAborted();
    console.log(`Approved ${bytes.length} bytes: ${sha256}`);
    // An application-specific release operation would consume `bytes` here.
  },
});
```

The SDK's [approval guide](https://pingroom.io/blog/agent-approvals-in-practice)
describes the request and decision contract. A real request sends the artifact
name, destination, digest, and correlation ID to PingRoom; it does not send the
artifact's contents. Use labels appropriate for the room and approver.

## Limits

This is a reference workflow. Live phone delivery is not exercised by the demo
or its tests. A real client relies on PingRoom authentication and HTTPS for the
decision; echoed metadata and a digest are not a signature proving human intent.
The caller, transport, and machine running the gate must be trusted.

The gate controls one callback invocation. It does not prevent a caller from
bypassing the gate, coordinate concurrent release jobs, persist approval usage
across restarts, or provide distributed exactly-once execution. Once the callback
starts, the gate cannot undo its effects. A callback error becomes a
`ReleaseExecutionError` with `actionStarted: true` and the original `cause`.
The gate never retries it; the application must handle partial execution.

Cancelling locally does not revoke an approval on the server. The SDK's create
method does not accept an AbortSignal, so a request may be created remotely even
if the local deadline wins. The gate still refuses to execute afterward.

The example requires the server expiry to remain unchanged and still be in the
future when execution starts. That freshness rule is stricter than the API,
which can return an already-decided approval after its expiry. Comparisons
between client and server timestamps allow five seconds of clock skew; the
local deadline and the check that expiry is still in the future remain strict.

For larger artifacts, adapt the workflow around immutable storage and ensure
the release operation consumes the exact object identified by the approved
digest. Increasing the size limit alone does not establish that guarantee.

## Verify changes

```sh
npm run build
node --test test/release-approval.test.mjs
```

The tests exercise SDK requests through the simulated transport, refused
outcomes, changed files, invalid response context, deadline handling, and the
verified bytes passed to the callback. The complete SDK suite also includes
these tests.
