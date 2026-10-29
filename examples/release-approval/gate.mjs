import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';

const MAX_BYTES = 1024 * 1024;
const OPTIONS = ['approve', 'deny'];
const CLOCK_SKEW_MS = 5000;

export class ReleaseApprovalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReleaseApprovalError';
    this.code = code;
  }
}

export class ReleaseExecutionError extends Error {
  constructor(cause) {
    super('The approved action started but did not complete successfully; its side effects may have occurred.', { cause });
    this.name = 'ReleaseExecutionError';
    this.actionStarted = true;
  }
}

function block(code, message) { throw new ReleaseApprovalError(code, message); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function label(value, name) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || Array.from(value).length > 120 || /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    block('invalid_input', `${name} must be 1–120 visible characters without surrounding whitespace.`);
  }
  return value;
}

async function snapshot(path) {
  // Nonblocking open prevents an accidentally supplied FIFO from hanging
  // before stat() can reject it. Only a regular, bounded file is read.
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES) {
      block('invalid_artifact', 'The artifact must be a regular file of 1–1048576 bytes.');
    }
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length < 1 || length > MAX_BYTES) block('invalid_artifact', 'The artifact changed size outside the allowed range.');
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

function timestamp(value) {
  // Accept the API's whole-second timestamps and fractional ISO timestamps,
  // while refusing Date.parse's permissive normalization of invalid dates.
  const parts = typeof value === 'string'
    && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) block('invalid_approval', 'Approval timestamps must be timezone-bearing ISO dates.');
  const [, year, month, day, hour, minute, second, zone] = parts;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  const validCalendar = calendar.getUTCFullYear() === Number(year)
    && calendar.getUTCMonth() === Number(month) - 1 && calendar.getUTCDate() === Number(day);
  const validZone = zone === 'Z' || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59);
  const time = Date.parse(value);
  if (!validCalendar || !validZone || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || !Number.isFinite(time)) {
    block('invalid_approval', 'Approval contains an invalid timestamp.');
  }
  return time;
}

function verifyBinding(approval, expected, approvalId) {
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)
    || typeof approval.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(approval.id)
    || (approvalId !== undefined && approval.id !== approvalId)
    || approval.room_code !== expected.room || approval.correlation_id !== expected.correlationId
    || approval.question !== expected.question || approval.title !== 'Release approval'
    || !Array.isArray(approval.options) || approval.options.length !== 2
    || !OPTIONS.every((option, i) => approval.options[i] === option)
    || !approval.data || Array.isArray(approval.data)
    || approval.data.artifact_name !== expected.artifactName
    || approval.data.sha256 !== expected.sha256 || approval.data.destination !== expected.destination) {
    block('invalid_approval', 'Approval does not match this artifact, destination, and request.');
  }
}

/**
 * Gate one callback invocation on a matching, current approval. The caller
 * supplies the trusted client and action; this example is not a durable
 * exactly-once protocol. The deadline gates when execute may START. Once it
 * starts, its side effects and response to the signal belong to the callback.
 */
export async function releaseWithApproval({ client, room, artifactPath, destination, execute, timeoutMs = 60000, signal }) {
  if (typeof client?.approvals?.request !== 'function' || typeof client?.approvals?.waitForDecision !== 'function' || typeof execute !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000
    || (signal !== undefined && !(signal instanceof AbortSignal))
    || typeof artifactPath !== 'string' || !artifactPath
    || typeof room !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(room)) {
    block('invalid_input', 'Supply a client, room, artifact path, callback, and a 1–300000 ms timeout.');
  }
  // The server upper-cases invite codes (`ab12cd` and `AB12CD` are one room)
  // and echoes the upper-case form. Normalise first, or the approval would be
  // created, shown to the human, and then refused by verifyBinding below.
  const roomCode = room.toUpperCase();
  const artifactName = label(basename(artifactPath), 'Artifact name');
  label(destination, 'Destination');
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  const timeout = () => controller.abort(new ReleaseApprovalError('timeout', 'Approval deadline elapsed.'));
  const cancel = () => controller.abort(new ReleaseApprovalError('cancelled', 'Release cancelled.'));
  const timer = setTimeout(timeout, timeoutMs);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  function check() {
    if (performance.now() >= deadline) timeout();
    if (controller.signal.aborted) throw controller.signal.reason;
  }
  function bounded(operation) {
    check();
    return new Promise((resolve, reject) => {
      const abort = () => { controller.signal.removeEventListener('abort', abort); reject(controller.signal.reason); };
      controller.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { check(); return operation(); }).then(
        (value) => { controller.signal.removeEventListener('abort', abort); resolve(value); },
        (error) => { controller.signal.removeEventListener('abort', abort); reject(error); },
      );
    });
  }
  try {
    const sha256 = digest(await bounded(() => snapshot(artifactPath)));
    const question = `Release ${artifactName} to ${destination}?\nSHA-256: ${sha256}\nApprove only these exact bytes and this destination.`;
    if (Array.from(question).length > 500) block('invalid_input', 'The approval question exceeds 500 characters.');
    const expected = { room: roomCode, artifactName, destination, sha256, question, correlationId: `release-${randomUUID()}` };
    const ttl = Math.max(60, Math.ceil(timeoutMs / 1000));
    const requestedAt = Date.now();
    // request() has no AbortSignal parameter. The local race bounds waiting,
    // but a timed-out create may still produce a remote request that expires.
    const created = await bounded(() => client.approvals.request(roomCode, {
      question, title: 'Release approval', options: [...OPTIONS], ttl,
      correlation_id: expected.correlationId,
      data: { artifact_name: artifactName, sha256, destination },
    }));
    check();
    verifyBinding(created, expected);
    const expiresAt = timestamp(created.expires_at);
    if (created.status !== 'pending' || created.decision !== null || created.decided_at !== null
      || expiresAt <= Date.now() || expiresAt > Date.now() + ttl * 1000 + CLOCK_SKEW_MS) {
      block('invalid_approval', 'Created approval must be pending with a valid future expiry.');
    }
    const approvalId = created.id;
    // The SDK refuses a wait response that is not this approval in a known
    // status; the gate reports that the same way as its own binding checks.
    const decided = await bounded(() => client.approvals.waitForDecision(approvalId, { signal: controller.signal }))
      .catch((error) => {
        if (error?.code === 'invalid_response') block('invalid_approval', 'PingRoom returned a malformed approval.');
        throw error;
      });
    check();
    verifyBinding(decided, expected, approvalId);
    if (timestamp(decided.expires_at) !== expiresAt) block('invalid_approval', 'Approval expiry changed.');
    if (decided.status === 'expired' || decided.status === 'cancelled') {
      if (decided.decision !== null || decided.decided_at !== null) block('invalid_approval', 'An unresolved approval cannot contain a decision.');
      block(decided.status, `Approval ${decided.status}; the action was not started.`);
    }
    if (decided.status !== 'decided' || !OPTIONS.includes(decided.decision)) {
      block('invalid_approval', 'Only status decided with an exact approve or deny decision is accepted.');
    }
    const decidedAt = timestamp(decided.decided_at);
    // Server timestamps may use whole seconds and a slightly different clock.
    // This allowance never extends the local deadline or the returned expiry.
    if (decidedAt < Math.floor(requestedAt / 1000) * 1000 - CLOCK_SKEW_MS
      || decidedAt > Date.now() + CLOCK_SKEW_MS || decidedAt > expiresAt) {
      block('invalid_approval', 'The approval decision timestamp is outside this request lifetime.');
    }
    if (Date.now() >= expiresAt) block('expired', 'Approval expired before the action could start.');
    if (decided.decision === 'deny') block('denied', 'The human denied this release.');
    const bytes = await bounded(() => snapshot(artifactPath));
    if (digest(bytes) !== sha256) block('changed', 'Artifact bytes changed after the approval was requested.');
    check();
    if (Date.now() >= expiresAt) block('expired', 'Approval expired before the action could start.');
    // Pass the verified bytes, not a pathname to reopen after the check.
    try {
      await execute({ bytes, sha256, artifactName, destination, approvalId, signal: controller.signal });
    } catch (error) {
      throw new ReleaseExecutionError(error);
    }
    return { outcome: 'executed', approvalId, sha256, destination };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
