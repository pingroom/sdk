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
export type { JsonRpcError, McpInitializeResult, McpTool, McpToolResult } from './mcp.js';

export {
  PingRoomError,
  PingRoomTimeoutError,
  PingRoomNetworkError,
  PingRoomActivationIncompleteError,
  AGENT_INBOX_ERROR_CODES,
  HANDOFF_ERROR_CODES,
  ROOM_SCOPED_ERROR_CODES,
} from './errors.js';
export type {
  AgentErrorCode,
  AgentInboxActivationIncompleteReason,
  AgentInboxErrorCode,
  ApiErrorBody,
  HandoffErrorCode,
  PingRoomErrorInit,
  RoomScopedErrorCode,
} from './errors.js';

export {
  verifyWebhookSignature,
  sendIncomingWebhook,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_V2_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  INCOMING_WEBHOOK_FIELDS,
} from './webhooks.js';
export type {
  VerifyWebhookSignatureOptions,
  IncomingWebhookPayload,
  SendIncomingWebhookOptions,
  IncomingWebhookResult,
} from './webhooks.js';

export { linkPing } from './linkPing.js';
export type { LinkPingInput, LinkPingData } from './linkPing.js';

export { locationPing, extractLocationPing } from './locationPing.js';
export type {
  LocationPingInput,
  LocationPingLocation,
  LocationPingData,
} from './locationPing.js';

export { liveStatus } from './liveStatus.js';
export type {
  LiveStatus,
  LiveStatusState,
  LiveStatusCategory,
  LiveStatusMetric,
  LiveStatusOption,
  LiveStatusSide,
  LiveStatusPing,
  LiveStatusResult,
  LiveStatusSnapshot,
} from './liveStatus.js';

export { liveActivity } from './liveActivity.js';
export type {
  LiveActivityTemplate,
  LiveActivityStatus,
  LiveActivityMetric,
  LiveActivityOption,
  LiveActivitySide,
  LiveActivityIdentity,
  LiveActivityData,
} from './liveActivity.js';

export { VERSION } from './version.js';

export type * from './types.js';

export default PingRoom;
