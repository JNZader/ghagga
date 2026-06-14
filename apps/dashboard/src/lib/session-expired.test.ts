/**
 * Tests for the cross-module session-expiry signal.
 *
 * The module holds a process-wide latch (`sessionExpiredPending`). Because the
 * state is module-level, we reset it at the start of each test by draining any
 * leftover latch via consumeSessionExpired() so tests stay independent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeSessionExpired,
  notifySessionExpired,
  SESSION_EXPIRED_EVENT,
} from './session-expired';

beforeEach(() => {
  // Drain any latch left over from a previous test so each test starts clean.
  consumeSessionExpired();
});

afterEach(() => {
  vi.restoreAllMocks();
  consumeSessionExpired();
});

describe('SESSION_EXPIRED_EVENT', () => {
  it('exposes the namespaced event name', () => {
    expect(SESSION_EXPIRED_EVENT).toBe('ghagga:session-expired');
  });
});

describe('notifySessionExpired', () => {
  it('dispatches the SESSION_EXPIRED_EVENT on window', () => {
    const handler = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, handler);

    notifySessionExpired();

    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener(SESSION_EXPIRED_EVENT, handler);
  });

  it('sets (latches) the pending flag so a missed listener can drain it later', () => {
    // Notify with NO live listener registered — the live event is lost, but the
    // latch must still record that a session-expiry happened.
    notifySessionExpired();

    expect(consumeSessionExpired()).toBe(true);
  });
});

describe('consumeSessionExpired', () => {
  it('returns false when no signal has fired (cold boot)', () => {
    expect(consumeSessionExpired()).toBe(false);
  });

  it('returns true exactly once after a signal, then false (single-shot latch)', () => {
    notifySessionExpired();

    expect(consumeSessionExpired()).toBe(true);
    expect(consumeSessionExpired()).toBe(false);
    expect(consumeSessionExpired()).toBe(false);
  });

  it('re-arms after a fresh signal following a drain', () => {
    notifySessionExpired();
    expect(consumeSessionExpired()).toBe(true);
    expect(consumeSessionExpired()).toBe(false);

    // A second session-expiry must latch again independently.
    notifySessionExpired();
    expect(consumeSessionExpired()).toBe(true);
    expect(consumeSessionExpired()).toBe(false);
  });

  it('stays latched across multiple notifies until a single consume drains it', () => {
    // Two pre-mount 401s before AuthProvider mounts: the latch is idempotent —
    // a single consume drains it regardless of how many notifies fired.
    notifySessionExpired();
    notifySessionExpired();

    expect(consumeSessionExpired()).toBe(true);
    expect(consumeSessionExpired()).toBe(false);
  });
});
