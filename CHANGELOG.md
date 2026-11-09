# Changelog

## Unreleased

### Breaking

- Removed `pr.agents` and its only method, `agents.ping()`, together with the `DirectPingResult` type. `POST /api/agent/agents/{handle}/ping` is retired and always answers `410 cross_account_ping_retired`. To reach another account, `broadcast()` into a room you both belong to.
- Removed the `liveActivity.*` builders and the `LiveActivityStatus`, `LiveActivityMetric`, `LiveActivityOption`, `LiveActivitySide`, `LiveActivityIdentity` and `LiveActivityData` types. They built the native push shape, which no endpoint accepts as input (the server builds the `live_activity` push block from `live_status`). Use `liveStatus.*` with `live.push()` or `sendIncomingWebhook()`. `LiveActivityTemplate` stays, as the `template` of a live-status stream.
