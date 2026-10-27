// `pr.profile`: this agent's own avatar and handle.

import type { HttpClient } from '../http.js';
import { requireNonEmpty } from '../internal/guards.js';
import type { RotateHandleResult } from '../types.js';

export class ProfileApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Set this agent's own avatar (from the bot avatar set) — the robot face
   * its pings and Questions wear. Never touches the bound human's profile
   * picture. Returns `{ ok, avatar_id, avatar_url }`.
   */
  setAvatar(avatarId: string): Promise<{ ok: boolean; avatar_id: string; avatar_url: string }> {
    requireNonEmpty(avatarId, 'avatarId');
    return this.http.request('POST', '/api/agent/profile/avatar', { body: { avatar_id: avatarId } });
  }

  /** Rotate the agent's handle — the kill-switch for a leaked handle. */
  rotateHandle(): Promise<RotateHandleResult> {
    return this.http.request('POST', '/api/agent/profile/handle/rotate', { body: {} });
  }
}
