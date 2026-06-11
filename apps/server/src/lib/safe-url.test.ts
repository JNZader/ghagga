/**
 * Unit tests for the SSRF outbound-URL validator.
 *
 * dns.lookup is mocked so no real DNS traffic happens; IP-literal cases
 * never reach DNS at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLookup = vi.fn();

vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => mockLookup(...args),
}));

import { validateOutboundUrl } from './safe-url.js';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY;
});

afterEach(() => {
  delete process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY;
});

describe('validateOutboundUrl', () => {
  // ── Parse / protocol / userinfo (always enforced) ──────────────

  it('rejects unparseable URLs', async () => {
    const result = await validateOutboundUrl('not a url at all');
    expect(result.ok).toBe(false);
  });

  it('rejects non-http(s) protocols (ftp:, file:, gopher:)', async () => {
    for (const raw of ['ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/']) {
      const result = await validateOutboundUrl(raw);
      expect(result.ok, `should reject ${raw}`).toBe(false);
    }
  });

  it('rejects URLs with userinfo', async () => {
    const result = await validateOutboundUrl('https://user:pass@example.com/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('userinfo');
  });

  it('rejects userinfo even with GHAGGA_ALLOW_PRIVATE_GATEWAY=true', async () => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = 'true';
    const result = await validateOutboundUrl('https://user:pass@10.0.0.1/');
    expect(result.ok).toBe(false);
  });

  it('rejects bad protocols even with GHAGGA_ALLOW_PRIVATE_GATEWAY=true', async () => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = 'true';
    const result = await validateOutboundUrl('ftp://example.com/');
    expect(result.ok).toBe(false);
  });

  // ── IPv4 literal ranges ────────────────────────────────────────

  it.each([
    ['http://127.0.0.1:6379/', 'loopback'],
    ['http://127.255.255.254/', 'loopback'],
    ['http://10.0.0.5/', 'private'],
    ['http://172.16.0.1/', 'private'],
    ['http://172.31.255.255/', 'private'],
    ['http://192.168.1.1/', 'private'],
    ['http://169.254.169.254/latest/meta-data/', 'link-local/metadata'],
    ['http://0.0.0.0:8080/', 'unspecified'],
  ])('rejects %s (%s)', async (raw, expectedReason) => {
    const result = await validateOutboundUrl(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(expectedReason);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('accepts borderline-public IPv4 literals (172.32.x, 192.169.x, 11.x)', async () => {
    for (const raw of ['http://172.32.0.1/', 'http://192.169.0.1/', 'http://11.0.0.1/']) {
      const result = await validateOutboundUrl(raw);
      expect(result.ok, `should accept ${raw}`).toBe(true);
    }
  });

  // ── IPv6 literal ranges ────────────────────────────────────────

  it.each([
    ['http://[::1]/', 'loopback'],
    ['http://[::]/', 'unspecified'],
    ['http://[fe80::1]/', 'link-local'],
    ['http://[fc00::1]/', 'private'],
    ['http://[fd12:3456::1]/', 'private'],
    ['http://[::ffff:127.0.0.1]/', 'loopback'],
    ['http://[::ffff:7f00:1]/', 'loopback'],
    ['http://[::ffff:169.254.169.254]/', 'link-local/metadata'],
  ])('rejects %s (%s)', async (raw, expectedReason) => {
    const result = await validateOutboundUrl(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(expectedReason);
  });

  it('accepts a public IPv6 literal', async () => {
    const result = await validateOutboundUrl('https://[2606:4700::6810:84e5]/');
    expect(result.ok).toBe(true);
  });

  // ── Hostname DNS resolution ────────────────────────────────────

  it('accepts a hostname resolving only to public addresses', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);

    const result = await validateOutboundUrl('https://gateway.example.com/v1');
    expect(result.ok).toBe(true);
    expect(mockLookup).toHaveBeenCalledWith('gateway.example.com', { all: true });
  });

  it('rejects a hostname when ANY resolved address is private (DNS rebinding mix)', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ]);

    const result = await validateOutboundUrl('https://evil.example.com/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('private');
  });

  it('rejects a hostname resolving to loopback (localhost)', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);

    const result = await validateOutboundUrl('http://localhost:3000/');
    expect(result.ok).toBe(false);
  });

  it('rejects a hostname resolving to the metadata endpoint', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);

    const result = await validateOutboundUrl('http://metadata.internal.example/');
    expect(result.ok).toBe(false);
  });

  it('rejects when DNS resolution fails', async () => {
    mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));

    const result = await validateOutboundUrl('https://does-not-exist.example/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('DNS resolution failed');
  });

  it('rejects when DNS resolution returns no addresses', async () => {
    mockLookup.mockResolvedValueOnce([]);

    const result = await validateOutboundUrl('https://empty.example/');
    expect(result.ok).toBe(false);
  });

  // ── Valid public URLs ──────────────────────────────────────────

  it('accepts a valid public https URL with a public IP literal', async () => {
    const result = await validateOutboundUrl('https://8.8.8.8/health');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.hostname).toBe('8.8.8.8');
  });

  // ── Escape hatch ───────────────────────────────────────────────

  it('GHAGGA_ALLOW_PRIVATE_GATEWAY=true allows private/loopback hosts', async () => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = 'true';

    for (const raw of [
      'http://10.0.0.5:8080/',
      'http://127.0.0.1:4000/',
      'http://gateway.internal.lan/',
    ]) {
      const result = await validateOutboundUrl(raw);
      expect(result.ok, `should accept ${raw} with escape hatch`).toBe(true);
    }
    // No DNS lookup needed when range checks are skipped
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('escape hatch is off for any value other than "true"', async () => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = '1';
    const result = await validateOutboundUrl('http://127.0.0.1/');
    expect(result.ok).toBe(false);
  });
});
