import test from 'node:test';
import assert from 'node:assert/strict';
import { linkPing } from '../dist/index.js';

test('linkPing builds the data fragment', () => {
  assert.deepEqual(
    linkPing({ url: 'https://ci.example.com/b/512', buttonLabel: 'Open build' }),
    { url: 'https://ci.example.com/b/512', button_label: 'Open build' },
  );
});

test('linkPing omits button_label when not given', () => {
  assert.deepEqual(linkPing({ url: 'https://example.com' }), { url: 'https://example.com' });
});

test('linkPing rejects a relative URL', () => {
  assert.throws(() => linkPing({ url: '/relative' }), /not a valid URL/);
});

test('linkPing rejects a non-http(s) scheme', () => {
  assert.throws(() => linkPing({ url: 'ftp://example.com/x' }), /absolute http\(s\)/);
});

test('linkPing rejects an over-long URL', () => {
  assert.throws(
    () => linkPing({ url: `https://example.com/${'x'.repeat(2048)}` }),
    /at most 2048/,
  );
});

test('linkPing rejects an over-long button label', () => {
  assert.throws(
    () => linkPing({ url: 'https://example.com', buttonLabel: 'x'.repeat(27) }),
    /at most 26/,
  );
});
