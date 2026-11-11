# Changelog

## Unreleased

### Added

- Tags on Pings. `broadcast()`, `sendIncomingWebhook()` and the `liveStatus.*` builders (`live.push()`) take `tags`: up to 10 labels, each 1–32 characters of lowercase letters, digits, `-` and `_`, starting with a letter or digit. The server trims, lowercases and de-duplicates them; the SDK checks them the same way first and sends what you gave it. A live-status stream's tags are set by its first ping and never changed by a later one. Reads return `tags` (sorted, `[]` when none) on `PingResult`, `NotificationDetail`, listed and listened notifications and the `live.get()` snapshot.
- Replace a ping you sent. `notifications.replace(inviteCode, notificationId, { message, title?, data? })` changes its text and data in place (`PUT /api/agent/rooms/{inviteCode}/notifications/{notificationId}`): the notification on each recipient's phone changes silently, with no second notification, no sound and unread counts unchanged. `title` and `data` keep their value when omitted and `null` clears them; the same text and data again is a no-op. Only an ordinary ping of yours in a private room, under 24 hours old and replaced fewer than 20 times can be replaced; each refusal has its own code, exported as `REPLACE_ERROR_CODES` / `ReplaceErrorCode` (and part of `AgentErrorCode`). A 404 with no `code` means the server has replacing switched off.
- `replaceKey` on `broadcast()` and `sendIncomingWebhook()` (sent as `replace_key`): a send with a key replaces your earlier ping with the same key in that room (same agent credential, or same webhook) while it is replaceable, and resolves with that ping and `replaced: true`; otherwise it sends a new ping that keeps the key. 1–64 characters of letters, digits, `.` `_` `:` `-`, checked before sending. `PingResult` and `IncomingWebhookResult` gain `replaced?: boolean`.
- `edited_at` (`string | null`) on `PingResult` and on listed, listened and read notifications: when the ping's text was last replaced, `null` when never.
- `notifications.list()`, `notifications.wait()` and `notifications.listen()` take `tag` to see only pings carrying it. `room_id`, already sent by `notifications.list()`, is now documented on `ListNotificationsInput`.

## 0.9.0 (2026-11-11)

### Fixed

- `live.claim(..., 'release')` now resolves when the server ends the request instead of reopening it. Letting go of a request past its deadline (or four hours after it was made, when it has none) is a 200 with `claim.status: 'expired'` and `state: 'failed'`. It used to throw `invalid_response`, and a retry threw the same way. Only `release` accepts that receipt; `claim`, `done` and `cancel` still reject it.
- The wait-route docs said every wait route shares one 30-requests-per-minute budget. Each wait route has its own.

### Breaking

- Removed `pr.agents` and its only method, `agents.ping()`, together with the `DirectPingResult` type. `POST /api/agent/agents/{handle}/ping` is retired and always answers `410 cross_account_ping_retired`. To reach another account, `broadcast()` into a room you both belong to.
- Removed the `liveActivity.*` builders and the `LiveActivityStatus`, `LiveActivityMetric`, `LiveActivityOption`, `LiveActivitySide`, `LiveActivityIdentity` and `LiveActivityData` types. They built the native push shape, which no endpoint accepts as input (the server builds the `live_activity` push block from `live_status`). Use `liveStatus.*` with `live.push()` or `sendIncomingWebhook()`. `LiveActivityTemplate` stays, as the `template` of a live-status stream.
