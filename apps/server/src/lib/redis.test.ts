/**
 * Unit tests for the inline-workflow callback helpers in redis.ts.
 *
 * redis.ts instantiates an ioredis client at import time, which would open a
 * real TCP connection. We mock `ioredis` with a no-op class so importing the
 * module is side-effect free and we can test the pure helpers in isolation.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('ioredis', () => {
  // Minimal stub: `new RedisMock(opts)` is a no-op; quit() resolves. No socket.
  class RedisMock {
    quit(): Promise<'OK'> {
      return Promise.resolve('OK');
    }
  }
  return { default: RedisMock };
});

import { CALLBACK_RESULT_TTL, callbackResultKey } from './redis.js';

describe('callbackResultKey', () => {
  it('formats the key as ghagga:callback:{callbackId}', () => {
    expect(callbackResultKey('abc-123')).toBe('ghagga:callback:abc-123');
  });

  it('embeds the raw callbackId verbatim (no encoding/trimming)', () => {
    expect(callbackResultKey('XYZ_456:weird/id')).toBe('ghagga:callback:XYZ_456:weird/id');
  });

  it('handles an empty callbackId', () => {
    expect(callbackResultKey('')).toBe('ghagga:callback:');
  });

  it('produces distinct keys for distinct ids', () => {
    expect(callbackResultKey('a')).not.toBe(callbackResultKey('b'));
  });
});

describe('CALLBACK_RESULT_TTL', () => {
  it('is at least 720 seconds (12 minutes)', () => {
    // Lower bound, not exact: a legitimate TTL increase should not break this.
    // The real invariant (TTL > 660 s poll window) is asserted below.
    expect(CALLBACK_RESULT_TTL).toBeGreaterThanOrEqual(720);
  });

  it('outlives the 11-minute (660 s) poll window', () => {
    const ELEVEN_MINUTES_S = 11 * 60;
    expect(CALLBACK_RESULT_TTL).toBeGreaterThan(ELEVEN_MINUTES_S);
  });
});
