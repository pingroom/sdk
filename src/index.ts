/**
 * @pingroom/sdk — official TypeScript/JavaScript SDK for the PingRoom agent API.
 *
 *   import { PingRoom } from '@pingroom/sdk';
 *   const pr = new PingRoom({ token: process.env.PINGROOM_TOKEN });
 *   await pr.broadcast('ab12cd', { message: 'Deploy shipped ✅' });
 */

import { PingRoom } from './client.js';

export { PingRoom };
/** Alias for {@link PingRoom}. */
export { PingRoom as PingRoomClient } from './client.js';

export { McpClient } from './mcp.js';
export type { JsonRpcError, McpTool, McpToolResult } from './mcp.js';

export { PingRoomError, PingRoomTimeoutError, PingRoomNetworkError } from './errors.js';
export type { ApiErrorBody, PingRoomErrorInit } from './errors.js';

export {
  verifyWebhookSignature,
  sendIncomingWebhook,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
} from './webhooks.js';
export type {
  VerifyWebhookSignatureOptions,
  IncomingWebhookPayload,
  SendIncomingWebhookOptions,
  IncomingWebhookResult,
} from './webhooks.js';

export { VERSION } from './version.js';

export type * from './types.js';

export default PingRoom;
