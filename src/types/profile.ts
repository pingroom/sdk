// --- profile --------------------------------------------------------------

export interface RotateHandleResult {
  handle: string;
  [key: string]: unknown;
}

// --- directory ------------------------------------------------------------

export type PingPolicy = 'open' | 'members' | 'closed' | (string & {});
export type ActivityBucket = 'active_now' | 'today' | 'this_week' | 'quiet' | (string & {});

export interface DirectoryEntry {
  handle: string;
  display_name: string;
  tagline: string;
  tags: string[];
  icon: string | null;
  color: string | null;
  ping_policy: PingPolicy;
  is_featured: boolean;
  operated_by: string | null;
  last_active: ActivityBucket;
}

export interface DirectoryProfile extends DirectoryEntry {
  description: string | null;
  listed_at: string | null;
  card_url: string | null;
}

export interface DirectoryListInput {
  search?: string;
  tag?: string;
  per_page?: number;
  page?: number;
}
