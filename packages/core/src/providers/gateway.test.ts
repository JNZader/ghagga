import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateViaGateway, pinnedFetch, resolveAndPinHost } from './gateway.js';

// ─── Local loopback server helper ───────────────────────────────
//
// The pinned client uses Node's real http/https stack (not global fetch), so
// transport tests hit a real loopback server. 127.0.0.1 is a forbidden range,
// so these tests enable the self-hosted escape hatch — pinning still applies,
// only the range check is skipped.

interface CapturedRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function withServer(
  responder: (req: CapturedRequest) => {
    status: number;
    body: string;
    headers?: Record<string, string>;
  },
  fn: (baseUrl: string, captured: () => CapturedRequest) => Promise<void>,
): Promise<void> {
  let captured: CapturedRequest = { headers: {}, body: '' };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      captured = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      const out = responder(captured);
      res.writeHead(out.status, { 'Content-Type': 'application/json', ...out.headers });
      res.end(out.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, () => captured);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('generateViaGateway', () => {
  beforeEach(() => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = 'true';
  });
  afterEach(() => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = undefined;
  });

  it('throws if gatewayUrl is missing', async () => {
    await expect(
      generateViaGateway('prompt', 'system', { gatewayUrl: '', gatewayToken: 'token' }),
    ).rejects.toThrow('Gateway URL not configured');
  });

  it('throws if gatewayToken is missing', async () => {
    await expect(
      generateViaGateway('prompt', 'system', {
        gatewayUrl: 'https://example.com',
        gatewayToken: '',
      }),
    ).rejects.toThrow('Gateway token not configured');
  });

  it('throws if no options provided', async () => {
    await expect(generateViaGateway('prompt')).rejects.toThrow('Gateway URL not configured');
  });

  it('sends correct request to gateway', async () => {
    const mockResponse = {
      text: 'Review result',
      provider: 'gateway',
      model: 'claude-sonnet-4-20250514',
      tokensUsed: 500,
    };

    await withServer(
      () => ({ status: 200, body: JSON.stringify(mockResponse) }),
      async (baseUrl, captured) => {
        const result = await generateViaGateway('review this code', 'you are a reviewer', {
          gatewayUrl: baseUrl,
          gatewayToken: 'test-token-123',
          model: 'auto',
          project: 'ghagga',
        });

        expect(result).toEqual(mockResponse);

        const req = captured();
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/v1/generate');
        expect(req.headers.authorization).toBe('Bearer test-token-123');
        expect(req.headers['content-type']).toBe('application/json');

        const body = JSON.parse(req.body);
        expect(body.prompt).toBe('review this code');
        expect(body.system).toBe('you are a reviewer');
        expect(body.model).toBe('auto');
        expect(body.project).toBe('ghagga');
      },
    );
  });

  it('forwards provider when set (bridge short-circuits model routing)', async () => {
    await withServer(
      () => ({
        status: 200,
        body: JSON.stringify({ text: 'ok', provider: 'codex-cli', model: 'gpt-5.5' }),
      }),
      async (baseUrl, captured) => {
        await generateViaGateway('prompt', undefined, {
          gatewayUrl: baseUrl,
          gatewayToken: 'test-token-123',
          provider: 'codex-cli',
          model: 'gpt-5.5',
        });
        const body = JSON.parse(captured().body);
        expect(body.provider).toBe('codex-cli');
        expect(body.model).toBe('gpt-5.5');
      },
    );
  });

  it('omits provider from the body when unset (backward compat)', async () => {
    await withServer(
      () => ({
        status: 200,
        body: JSON.stringify({ text: 'ok', provider: 'gateway', model: 'auto' }),
      }),
      async (baseUrl, captured) => {
        await generateViaGateway('prompt', undefined, {
          gatewayUrl: baseUrl,
          gatewayToken: 'test-token-123',
        });
        const body = JSON.parse(captured().body);
        expect(body.provider).toBeUndefined();
        expect('provider' in body).toBe(false);
      },
    );
  });

  it('throws on non-ok response', async () => {
    await withServer(
      () => ({ status: 401, body: 'Unauthorized' }),
      async (baseUrl) => {
        await expect(
          generateViaGateway('prompt', 'system', {
            gatewayUrl: baseUrl,
            gatewayToken: 'bad-token',
          }),
        ).rejects.toThrow('Gateway error (401): Unauthorized');
      },
    );
  });

  it('treats a 3xx redirect as a failed generation (never follows it)', async () => {
    // Node's http client does not auto-follow redirects, so a 3xx surfaces as a
    // non-ok response and generateViaGateway throws instead of chasing Location
    // to a potentially-private address.
    await withServer(
      () => ({ status: 302, body: '', headers: { Location: 'http://169.254.169.254/' } }),
      async (baseUrl) => {
        await expect(
          generateViaGateway('prompt', 'system', {
            gatewayUrl: baseUrl,
            gatewayToken: 'token',
          }),
        ).rejects.toThrow('Gateway error (302)');
      },
    );
  });

  it('sends without optional fields when not provided', async () => {
    await withServer(
      () => ({
        status: 200,
        body: JSON.stringify({ text: 'ok', provider: 'gateway', model: 'auto' }),
      }),
      async (baseUrl, captured) => {
        await generateViaGateway('prompt', undefined, {
          gatewayUrl: baseUrl,
          gatewayToken: 'token',
        });
        const body = JSON.parse(captured().body);
        expect(body.system).toBeUndefined();
        expect(body.model).toBeUndefined();
        expect(body.project).toBeUndefined();
      },
    );
  });
});

// ─── SEC-001: DNS-rebinding / SSRF pinning ──────────────────────

describe('resolveAndPinHost (SEC-001 SSRF pinning)', () => {
  const publicIp = '93.184.216.34'; // example.com

  beforeEach(() => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = undefined;
  });

  const resolveTo = (addrs: Array<{ address: string; family: number }>) => async () => addrs;

  it('rejects non-http(s) protocols', async () => {
    await expect(resolveAndPinHost('ftp://example.com')).rejects.toThrow('protocol not allowed');
    await expect(resolveAndPinHost('file:///etc/passwd')).rejects.toThrow('protocol not allowed');
  });

  it('rejects userinfo in the URL', async () => {
    await expect(
      resolveAndPinHost(
        'https://user:pass@example.com',
        resolveTo([{ address: publicIp, family: 4 }]),
      ),
    ).rejects.toThrow('userinfo');
  });

  it('pins to the resolved public IP for a normal hostname', async () => {
    const pin = await resolveAndPinHost(
      'https://gateway.example.com',
      resolveTo([{ address: publicIp, family: 4 }]),
    );
    expect(pin.ip).toBe(publicIp);
    expect(pin.hostname).toBe('gateway.example.com');
    expect(pin.family).toBe(4);
    expect(pin.port).toBe(443);
  });

  it('blocks loopback (127.0.0.0/8)', async () => {
    await expect(
      resolveAndPinHost(
        'https://evil.example.com',
        resolveTo([{ address: '127.0.0.1', family: 4 }]),
      ),
    ).rejects.toThrow('loopback');
  });

  it('blocks cloud metadata / link-local (169.254.169.254)', async () => {
    await expect(
      resolveAndPinHost(
        'https://evil.example.com',
        resolveTo([{ address: '169.254.169.254', family: 4 }]),
      ),
    ).rejects.toThrow('link-local/metadata');
  });

  it('blocks RFC-1918 private (10/172.16/192.168)', async () => {
    for (const ip of ['10.0.0.5', '172.16.9.9', '192.168.1.1']) {
      await expect(
        resolveAndPinHost('https://evil.example.com', resolveTo([{ address: ip, family: 4 }])),
      ).rejects.toThrow('private');
    }
  });

  it('blocks IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)', async () => {
    await expect(
      resolveAndPinHost(
        'https://evil.example.com',
        resolveTo([{ address: '::ffff:127.0.0.1', family: 6 }]),
      ),
    ).rejects.toThrow(/IPv4-mapped .*loopback/);
  });

  it('blocks IPv6 loopback (::1) and link-local (fe80::)', async () => {
    await expect(
      resolveAndPinHost('https://evil.example.com', resolveTo([{ address: '::1', family: 6 }])),
    ).rejects.toThrow('loopback');
    await expect(
      resolveAndPinHost('https://evil.example.com', resolveTo([{ address: 'fe80::1', family: 6 }])),
    ).rejects.toThrow('link-local');
  });

  it('rejects a MIXED public/private answer set entirely', async () => {
    // The classic rebind payload: a public record to pass a naive check plus an
    // internal record to actually connect to. Any forbidden record fails all.
    await expect(
      resolveAndPinHost(
        'https://rebind.example.com',
        resolveTo([
          { address: publicIp, family: 4 },
          { address: '169.254.169.254', family: 4 },
        ]),
      ),
    ).rejects.toThrow('link-local/metadata');
  });

  it('blocks CGNAT (100.64.0.0/10) and IETF protocol assignments (192.0.0.0/24)', async () => {
    await expect(
      resolveAndPinHost(
        'https://evil.example.com',
        resolveTo([{ address: '100.64.1.2', family: 4 }]),
      ),
    ).rejects.toThrow('CGNAT');
    await expect(
      resolveAndPinHost(
        'https://evil.example.com',
        resolveTo([{ address: '192.0.0.192', family: 4 }]),
      ),
    ).rejects.toThrow('IETF protocol assignment');
  });

  it('blocks multicast (224.0.0.0/4) and reserved (240.0.0.0/4)', async () => {
    await expect(
      resolveAndPinHost(
        'https://evil.example.com',
        resolveTo([{ address: '224.0.0.1', family: 4 }]),
      ),
    ).rejects.toThrow('multicast');
    await expect(
      resolveAndPinHost(
        'https://evil.example.com',
        resolveTo([{ address: '240.0.0.1', family: 4 }]),
      ),
    ).rejects.toThrow('reserved');
  });

  it('honors the self-hosted escape hatch for private IPs (still pins)', async () => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = 'true';
    const pin = await resolveAndPinHost(
      'http://gateway.internal',
      resolveTo([{ address: '10.1.2.3', family: 4 }]),
    );
    expect(pin.ip).toBe('10.1.2.3');
  });

  it('validates an IP literal host directly (no DNS)', async () => {
    await expect(resolveAndPinHost('http://127.0.0.1:8080')).rejects.toThrow('loopback');
  });

  it('rejects when DNS returns no addresses', async () => {
    await expect(resolveAndPinHost('https://void.example.com', resolveTo([]))).rejects.toThrow(
      'no addresses',
    );
  });
});

describe('resolveAndPinHost DNS deadline (SEC-001 follow-up)', () => {
  beforeEach(() => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = 'true';
  });
  afterEach(() => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = undefined;
  });

  // A resolver that never settles — simulates a hung DNS server.
  const hangForever = (): Promise<Array<{ address: string; family: number }>> =>
    new Promise(() => {});

  it('rejects promptly when the caller signal aborts during a hanging DNS lookup', async () => {
    const start = Date.now();
    await expect(
      resolveAndPinHost('https://slow.example.com', hangForever, {
        signal: AbortSignal.timeout(50),
      }),
    ).rejects.toThrow('aborted');
    // Must not hang until some far-off default; well under any real budget.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('rejects promptly when the DNS timeout elapses on a hanging lookup', async () => {
    const start = Date.now();
    await expect(
      resolveAndPinHost('https://slow.example.com', hangForever, { dnsTimeoutMs: 50 }),
    ).rejects.toThrow('timed out');
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('rejects immediately if the signal is already aborted', async () => {
    await expect(
      resolveAndPinHost('https://slow.example.com', hangForever, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow('aborted');
  });
});

describe('pinnedFetch POST framing (Content-Length, not chunked)', () => {
  beforeEach(() => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = 'true';
  });
  afterEach(() => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = undefined;
  });

  it('sends a POST body with Content-Length and never Transfer-Encoding: chunked', async () => {
    await withServer(
      () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
      async (baseUrl, captured) => {
        const body = JSON.stringify({ prompt: 'hello', system: 'sys' });
        const res = await pinnedFetch(`${baseUrl}/v1/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        expect(res.ok).toBe(true);

        const req = captured();
        expect(req.headers['content-length']).toBe(String(Buffer.byteLength(body)));
        expect(req.headers['transfer-encoding']).toBeUndefined();
        expect(req.body).toBe(body);
      },
    );
  });
});

describe('pinnedFetch resolve-once (SEC-001 TOCTOU)', () => {
  beforeEach(() => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = 'true';
  });
  afterEach(() => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = undefined;
  });

  it('resolves the hostname exactly once and pins the connection to it', async () => {
    await withServer(
      () => ({ status: 200, body: JSON.stringify({ ok: true }) }),
      async (baseUrl, captured) => {
        const { port } = new URL(baseUrl);
        let calls = 0;
        // First resolution → the loopback server. A SECOND resolution (the
        // rebind) would return an unreachable address — but pinning means it is
        // never consulted.
        const resolveAll = async () => {
          calls += 1;
          if (calls === 1) return [{ address: '127.0.0.1', family: 4 }];
          return [{ address: '203.0.113.7', family: 4 }]; // would-be rebind target
        };

        const res = await pinnedFetch(`http://gateway.example.com:${port}/v1/models`, {
          method: 'GET',
          headers: { Authorization: 'Bearer t' },
          resolveAll,
        });

        expect(res.ok).toBe(true);
        expect(calls).toBe(1); // resolved ONCE
        // Host header preserved as the ORIGINAL hostname, not the pinned IP.
        expect(captured().headers.host).toBe(`gateway.example.com:${port}`);
      },
    );
  });
});
