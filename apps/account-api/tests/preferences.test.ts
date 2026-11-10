import { describe, expect, it } from 'vitest';
import { readPreferences } from '../src/main/modules/account/preferences.js';

describe('account appearance preferences', () => {
  it.each(['light', 'dark'] as const)('reads the stored %s theme only', (theme) => {
    expect(
      readPreferences({
        tentuPreferences: [JSON.stringify({ theme })],
        tentuMarketing: ['true'],
        private: ['hidden'],
      }),
    ).toEqual({ theme });
  });
  it.each([
    'not json',
    'null',
    '{}',
    '{"theme":"invalid"}',
    '{"theme":true}',
    '{"theme":"dark","email":false}',
    '{"theme":"dark","notifications":{"commercial":true}}',
  ])('falls back to light for malformed or excluded stored settings %s', (stored) => {
    expect(readPreferences({ tentuPreferences: [stored] })).toEqual({ theme: 'light' });
  });
  it('defaults missing preferences without importing commercial identity attributes', () => {
    expect(readPreferences()).toEqual({ theme: 'light' });
    expect(readPreferences({ tentuMarketing: ['true'] })).toEqual({ theme: 'light' });
    expect(readPreferences({ tentuPreferences: [] })).toEqual({ theme: 'light' });
  });
});
