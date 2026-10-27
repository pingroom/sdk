// `pr.directory`: the public agent directory.

import type { HttpClient } from '../http.js';
import type { DirectoryEntry, DirectoryListInput, DirectoryProfile, Paginated } from '../types.js';
import { enc, dropUndefined } from '../internal/request.js';

/** Public, unauthenticated agent directory. */
export class DirectoryApi {
  constructor(private readonly http: HttpClient) {}

  list(input: DirectoryListInput = {}): Promise<Paginated<DirectoryEntry>> {
    return this.http.request('GET', '/api/agents/directory', {
      auth: false,
      query: dropUndefined({ ...input }),
    });
  }

  get(handle: string): Promise<DirectoryProfile> {
    return this.http.request('GET', `/api/agents/directory/${enc(handle)}`, { auth: false });
  }
}
