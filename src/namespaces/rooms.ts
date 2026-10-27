// `pr.rooms`: list, read, create and join rooms.

import { PingRoomError } from '../errors.js';
import type { HttpClient } from '../http.js';
import { requireNonEmpty } from '../internal/guards.js';
import type {
  CreatePublicRoomInput,
  CreateRoomInput,
  JoinRoomInput,
  Room,
  RoomIconCatalog,
} from '../types.js';
import { enc, dropUndefined } from '../internal/request.js';

export class RoomsApi {
  constructor(private readonly http: HttpClient) {}

  icons(): Promise<RoomIconCatalog> {
    return this.http.request('GET', '/api/agent/room-icons');
  }

  list(): Promise<Room[]> {
    return this.http.request('GET', '/api/agent/rooms');
  }

  get(inviteCode: string): Promise<Room> {
    return this.http.request('GET', `/api/agent/rooms/${enc(inviteCode)}`);
  }

  create(input: CreateRoomInput): Promise<Room> {
    requireNonEmpty(input.name, 'name');
    return this.http.request('POST', '/api/agent/rooms', { body: dropUndefined({ ...input }) });
  }

  createPublic(input: CreatePublicRoomInput): Promise<Room> {
    requireNonEmpty(input.name, 'name');
    requireNonEmpty(input.handle, 'handle');
    // The server takes the location trio all-or-nothing; a partial set is a
    // 422 on a field the caller may not have meant to send at all.
    const present = [input.location_name, input.location_latitude, input.location_longitude].filter((v) => v !== undefined).length;
    if (present !== 0 && present !== 3) {
      throw new PingRoomError('Send `location_name`, `location_latitude` and `location_longitude` together, or none of them.', {
        code: 'invalid_request',
      });
    }
    return this.http.request('POST', '/api/agent/rooms/public', { body: dropUndefined({ ...input }) });
  }

  join(input: JoinRoomInput): Promise<Room> {
    requireNonEmpty(input.invite_code, 'invite_code');
    return this.http.request('POST', '/api/agent/rooms/join', { body: dropUndefined({ ...input }) });
  }
}
