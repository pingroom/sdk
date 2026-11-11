# Changelog

## Unreleased

### Added

- Tags on Pings. `broadcast()`, `sendIncomingWebhook()` and the `liveStatus.*` builders (`live.push()`) take `tags`: up to 10 labels, each 1–32 characters of lowercase letters, digits, `-` and `_`, starting with a letter or digit. The server trims, lowercases and de-duplicates them; the SDK checks them the same way first and sends what you gave it. A live-status stream's tags are set by its first ping and never changed by a later one. Reads return `tags` (sorted, `[]` when none) on `PingResult`, `NotificationDetail`, listed and listened notifications and the `live.get()` snapshot.
- `notifications.list()`, `notifications.wait()` and `notifications.listen()` take `tag` to see only pings carrying it. `room_id`, already sent by `notifications.list()`, is now documented on `ListNotificationsInput`.

## 0.9.0 (2026-11-11)

### Fixed

- `live.claim(..., 'release')` now resolves when the server ends the request instead of reopening it. Letting go of a request past its deadline (or four hours after it was made, when it has none) is a 200 with `claim.status: 'expired'` and `state: 'failed'`. It used to throw `invalid_response`, and a retry threw the same way. Only `release` accepts that receipt; `claim`, `done` and `cancel` still reject it.
- The wait-route docs said every wait route shares one 30-requests-per-minute budget. Each wait route has its own.

### Breaking

- Removed `pr.agents` and its only method, `agents.ping()`, together with the `DirectPingResult` type. `POST /api/agent/agents/{handle}/ping` is retired and always answers `410 cross_account_ping_retired`. To reach another account, `broadcast()` into a room you both belong to.
- Removed the `liveActivity.*` builders and the `LiveActivityStatus`, `LiveActivityMetric`, `LiveActivityOption`, `LiveActivitySide`, `LiveActivityIdentity` and `LiveActivityData` types. They built the native push shape, which no endpoint accepts as input (the server builds the `live_activity` push block from `live_status`). Use `liveStatus.*` with `live.push()` or `sendIncomingWebhook()`. `LiveActivityTemplate` stays, as the `template` of a live-status stream.
