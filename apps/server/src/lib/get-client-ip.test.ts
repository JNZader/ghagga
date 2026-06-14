/**
 * Unit tests for getClientIp.
 *
 * getClientIp only reads request headers, so we feed it a minimal Hono-shaped
 * stub whose `req.header(name)` returns values from a case-insensitive map.
 */

import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { getClientIp } from './get-client-ip.js';

/**
 * Build a minimal Context stub. Header lookups are case-insensitive, matching
 * Hono's real behaviour (getClientIp queries lowercase header names).
 */
function makeContext(headers: Record<string, string | undefined>): Context {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      normalized.set(key.toLowerCase(), value);
    }
  }
  return {
    req: {
      header: (name: string): string | undefined => normalized.get(name.toLowerCase()),
    },
  } as unknown as Context;
}

describe('getClientIp', () => {
  it('returns the LAST IP from an X-Forwarded-For chain (proxy-appended)', () => {
    const c = makeContext({
      'x-forwarded-for': '203.0.113.7, 198.51.100.4, 10.0.0.1',
    });
    expect(getClientIp(c)).toBe('10.0.0.1');
  });

  it('returns the single IP when X-Forwarded-For has only one entry', () => {
    const c = makeContext({ 'x-forwarded-for': '203.0.113.7' });
    expect(getClientIp(c)).toBe('203.0.113.7');
  });

  it('trims surrounding whitespace around the chosen IP', () => {
    const c = makeContext({ 'x-forwarded-for': '203.0.113.7 ,   198.51.100.4   ' });
    expect(getClientIp(c)).toBe('198.51.100.4');
  });

  it('falls back to X-Real-IP when X-Forwarded-For is absent', () => {
    const c = makeContext({ 'x-real-ip': '192.0.2.55' });
    expect(getClientIp(c)).toBe('192.0.2.55');
  });

  it("falls back to 'unknown' when no IP headers are present", () => {
    const c = makeContext({});
    expect(getClientIp(c)).toBe('unknown');
  });

  it("returns 'unknown' for a malformed X-Forwarded-For that trims to empty", () => {
    // A header whose last entry is blank (e.g. trailing comma) yields '' after
    // trim; getClientIp coalesces that to 'unknown'.
    const c = makeContext({ 'x-forwarded-for': '203.0.113.7, ' });
    expect(getClientIp(c)).toBe('unknown');
  });

  it("returns 'unknown' for an empty X-Forwarded-For string (falls through to X-Real-IP fallback)", () => {
    // Empty string is falsy, so the X-Forwarded-For branch is skipped entirely
    // and we fall through to X-Real-IP, then to 'unknown'.
    const c = makeContext({ 'x-forwarded-for': '' });
    expect(getClientIp(c)).toBe('unknown');
  });

  it("returns 'unknown' for an empty X-Real-IP header", () => {
    // A present-but-empty X-Real-IP must coalesce to 'unknown', matching the
    // X-Forwarded-For branch's handling of blank values.
    const c = makeContext({ 'x-real-ip': '' });
    expect(getClientIp(c)).toBe('unknown');
  });

  it("returns 'unknown' for a whitespace-only X-Real-IP header", () => {
    // A whitespace-only X-Real-IP trims to '' and must coalesce to 'unknown'.
    const c = makeContext({ 'x-real-ip': '   ' });
    expect(getClientIp(c)).toBe('unknown');
  });

  it('prefers X-Forwarded-For over X-Real-IP when both are present', () => {
    const c = makeContext({
      'x-forwarded-for': '203.0.113.7, 10.0.0.2',
      'x-real-ip': '192.0.2.55',
    });
    expect(getClientIp(c)).toBe('10.0.0.2');
  });
});
