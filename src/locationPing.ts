/**
 * Location pings — attach a map-ready point to a ping.
 *
 * The reserved wire shape lives at `data.location`:
 *
 *   await pr.broadcast('ab12cd', {
 *     message: 'Meet me here',
 *     data: { event: 'lunch', ...locationPing({
 *       latitude: 25.2048,
 *       longitude: 55.2708,
 *       label: 'Dubai Mall',
 *     }) },
 *   });
 */

export interface LocationPingInput {
  /** Latitude in decimal degrees, inclusive -90..90. */
  latitude: number;
  /** Longitude in decimal degrees, inclusive -180..180. */
  longitude: number;
  /** Optional display label. Max 100 Unicode characters. */
  label?: string;
  /** Optional human-readable address. Max 255 Unicode characters. */
  address?: string;
}

/** The validated value stored under the reserved `data.location` key. */
export interface LocationPingLocation {
  latitude: number;
  longitude: number;
  label?: string;
  address?: string;
}

/** A fragment that can be spread into a ping's structured `data` object. */
export interface LocationPingData {
  location: LocationPingLocation;
  [key: string]: unknown;
}

const LABEL_MAX = 100;
const ADDRESS_MAX = 255;

function requireCoordinate(value: unknown, name: 'latitude' | 'longitude', min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`locationPing: ${name} must be a finite JSON number`);
  }
  if (value < min || value > max) {
    throw new TypeError(`locationPing: ${name} must be between ${min} and ${max}`);
  }
  return value;
}

function optionalString(value: unknown, name: 'label' | 'address', max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new TypeError(`locationPing: ${name} must be a string`);
  }
  const length = Array.from(value).length;
  if (length > max) {
    throw new TypeError(`locationPing: ${name} must be at most ${max} characters`);
  }
  return value;
}

function validateLocation(input: unknown): LocationPingLocation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('locationPing: input must be an object');
  }

  const candidate = input as Record<string, unknown>;
  const location: LocationPingLocation = {
    latitude: requireCoordinate(candidate.latitude, 'latitude', -90, 90),
    longitude: requireCoordinate(candidate.longitude, 'longitude', -180, 180),
  };
  const label = optionalString(candidate.label, 'label', LABEL_MAX);
  const address = optionalString(candidate.address, 'address', ADDRESS_MAX);
  if (label !== undefined) location.label = label;
  if (address !== undefined) location.address = address;
  return location;
}

/** Build and validate the reserved `data.location` fragment for a location ping. */
export function locationPing(input: LocationPingInput): LocationPingData {
  return { location: validateLocation(input) };
}

/**
 * Read a valid reserved location from an arbitrary received `data` value.
 * Invalid or absent location metadata is ignored instead of throwing while a
 * notification feed is being processed.
 */
export function extractLocationPing(data: unknown): LocationPingLocation | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!Object.hasOwn(data, 'location')) return null;
  try {
    return validateLocation((data as Record<string, unknown>).location);
  } catch {
    return null;
  }
}
