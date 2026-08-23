import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLocationPing, locationPing } from '../dist/index.js';

test('locationPing builds the reserved location fragment', () => {
  assert.deepEqual(
    locationPing({
      latitude: 25.2048,
      longitude: 55.2708,
      label: 'Dubai Mall',
      address: 'Downtown Dubai',
    }),
    {
      location: {
        latitude: 25.2048,
        longitude: 55.2708,
        label: 'Dubai Mall',
        address: 'Downtown Dubai',
      },
    },
  );
});

test('locationPing accepts inclusive coordinate boundaries and omits absent strings', () => {
  assert.deepEqual(locationPing({ latitude: -90, longitude: 180 }), {
    location: { latitude: -90, longitude: 180 },
  });
  assert.deepEqual(locationPing({ latitude: 90, longitude: -180 }), {
    location: { latitude: 90, longitude: -180 },
  });
});

test('locationPing requires true finite JSON numbers', () => {
  for (const latitude of ['25.2', NaN, Infinity, -Infinity, null]) {
    assert.throws(
      () => locationPing({ latitude, longitude: 55.3 }),
      /latitude must be a finite JSON number/,
    );
  }
  assert.throws(
    () => locationPing({ latitude: 25.2, longitude: '55.3' }),
    /longitude must be a finite JSON number/,
  );
});

test('locationPing rejects coordinates outside their inclusive ranges', () => {
  assert.throws(() => locationPing({ latitude: 90.000001, longitude: 0 }), /latitude.*-90.*90/);
  assert.throws(() => locationPing({ latitude: 0, longitude: -180.000001 }), /longitude.*-180.*180/);
});

test('locationPing applies label and address caps to Unicode characters', () => {
  assert.doesNotThrow(() => locationPing({
    latitude: 0,
    longitude: 0,
    label: '📍'.repeat(100),
    address: '📍'.repeat(255),
  }));
  assert.throws(
    () => locationPing({ latitude: 0, longitude: 0, label: '📍'.repeat(101) }),
    /label must be at most 100 characters/,
  );
  assert.throws(
    () => locationPing({ latitude: 0, longitude: 0, address: '📍'.repeat(256) }),
    /address must be at most 255 characters/,
  );
});

test('locationPing rejects non-string optional metadata', () => {
  assert.throws(() => locationPing({ latitude: 0, longitude: 0, label: null }), /label must be a string/);
  assert.throws(() => locationPing({ latitude: 0, longitude: 0, address: 123 }), /address must be a string/);
});

test('extractLocationPing returns a validated copy or null', () => {
  const source = {
    location: { latitude: 51.5072, longitude: -0.1276, label: 'London' },
    sibling: true,
  };
  assert.deepEqual(extractLocationPing(source), {
    latitude: 51.5072,
    longitude: -0.1276,
    label: 'London',
  });
  assert.notEqual(extractLocationPing(source), source.location);
  assert.equal(extractLocationPing({}), null);
  assert.equal(extractLocationPing({ location: { latitude: '51.5', longitude: -0.1 } }), null);
  assert.equal(extractLocationPing(null), null);
});
