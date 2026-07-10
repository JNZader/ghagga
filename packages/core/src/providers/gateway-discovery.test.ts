import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderChainEntry } from '../types.js';
import {
  fetchGatewayModels,
  fetchGatewayProviders,
  type GatewayModelEntry,
  type GatewayProviderStatus,
  validateProviderChain,
} from './gateway-discovery.js';

const TOKEN = 'test-token';

// Loopback server helper — the pinned client uses Node's real http stack, so
// discovery transport tests hit a local server. 127.0.0.1 is a forbidden range,
// so the self-hosted escape hatch is enabled (pinning still applies).
interface Captured {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
}

async function withServer(
  responder: () => { status: number; body: string },
  fn: (baseUrl: string, captured: () => Captured) => Promise<void>,
): Promise<void> {
  let captured: Captured = { headers: {} };
  const server = http.createServer((req, res) => {
    captured = { method: req.method, url: req.url, headers: req.headers };
    const out = responder();
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(out.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, () => captured);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function gatewayEntry(over: Partial<ProviderChainEntry> = {}): ProviderChainEntry {
  return {
    provider: 'gateway',
    model: 'auto',
    apiKey: '',
    gatewayUrl: 'https://llm-gateway.example.com',
    ...over,
  };
}

describe('fetchGatewayModels', () => {
  beforeEach(() => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = 'true';
  });
  afterEach(() => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = undefined;
  });

  it('returns the data array from GET /v1/models with auth (pinned client)', async () => {
    await withServer(
      () => ({
        status: 200,
        body: JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.5', provider: 'codex-cli' }] }),
      }),
      async (baseUrl, captured) => {
        const models = await fetchGatewayModels(baseUrl, TOKEN);
        expect(models).toEqual([{ id: 'gpt-5.5', provider: 'codex-cli' }]);
        expect(captured().method).toBe('GET');
        expect(captured().url).toBe('/v1/models');
        expect(captured().headers.authorization).toBe(`Bearer ${TOKEN}`);
      },
    );
  });

  it('returns [] when data is missing', async () => {
    await withServer(
      () => ({ status: 200, body: JSON.stringify({ object: 'list' }) }),
      async (baseUrl) => {
        expect(await fetchGatewayModels(baseUrl, TOKEN)).toEqual([]);
      },
    );
  });

  it('filters out malformed entries (no string id)', async () => {
    await withServer(
      () => ({
        status: 200,
        body: JSON.stringify({ data: [null, { id: 'gpt-5.5' }, { nope: 1 }, 42] }),
      }),
      async (baseUrl) => {
        expect(await fetchGatewayModels(baseUrl, TOKEN)).toEqual([{ id: 'gpt-5.5' }]);
      },
    );
  });

  it('throws on non-ok response', async () => {
    await withServer(
      () => ({ status: 500, body: 'nope' }),
      async (baseUrl) => {
        await expect(fetchGatewayModels(baseUrl, TOKEN)).rejects.toThrow('Gateway error (500)');
      },
    );
  });

  it('throws when URL is missing', async () => {
    await expect(fetchGatewayModels('', TOKEN)).rejects.toThrow('Gateway URL not configured');
  });
});

describe('fetchGatewayProviders', () => {
  beforeEach(() => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = 'true';
  });
  afterEach(() => {
    process.env.GHAGGA_ALLOW_PRIVATE_GATEWAY = undefined;
  });

  it('returns the providers array from GET /v1/providers (pinned client)', async () => {
    await withServer(
      () => ({
        status: 200,
        body: JSON.stringify({
          providers: [{ id: 'codex-cli', name: 'Codex', type: 'cli', available: true }],
        }),
      }),
      async (baseUrl, captured) => {
        const providers = await fetchGatewayProviders(baseUrl, TOKEN);
        expect(providers).toEqual([
          { id: 'codex-cli', name: 'Codex', type: 'cli', available: true },
        ]);
        expect(captured().url).toBe('/v1/providers');
      },
    );
  });
});

describe('validateProviderChain', () => {
  const models: GatewayModelEntry[] = [
    { id: 'gpt-5.5', provider: 'codex-cli' },
    { id: 'claude-opus-4-6', provider: 'cli-claude' },
  ];
  const providers: GatewayProviderStatus[] = [
    { id: 'codex-cli', name: 'Codex', type: 'cli', available: true },
    { id: 'cli-claude', name: 'Claude', type: 'cli', available: true },
    { id: 'openai', name: 'OpenAI', type: 'api', available: false },
  ];

  it('accepts a known, available provider + advertised model', () => {
    const entry = gatewayEntry({ targetProvider: 'codex-cli', model: 'gpt-5.5' });
    const { valid, invalid } = validateProviderChain([entry], models, providers);
    expect(valid).toEqual([entry]);
    expect(invalid).toEqual([]);
  });

  it('rejects an unknown targetProvider', () => {
    const entry = gatewayEntry({ targetProvider: 'ghost-cli', model: 'gpt-5.5' });
    const { invalid } = validateProviderChain([entry], models, providers);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.reason).toMatch(/unknown bridge provider/);
  });

  it('rejects an unavailable provider', () => {
    const entry = gatewayEntry({ targetProvider: 'openai', model: 'auto' });
    const { invalid } = validateProviderChain([entry], models, providers);
    expect(invalid[0]?.reason).toMatch(/unavailable/);
  });

  it('rejects a model not advertised by the target provider', () => {
    const entry = gatewayEntry({ targetProvider: 'codex-cli', model: 'claude-opus-4-6' });
    const { invalid } = validateProviderChain([entry], models, providers);
    expect(invalid[0]?.reason).toMatch(/not advertised by provider/);
  });

  it("does not validate the model when it is 'auto'", () => {
    const entry = gatewayEntry({ targetProvider: 'codex-cli', model: 'auto' });
    const { valid } = validateProviderChain([entry], models, providers);
    expect(valid).toEqual([entry]);
  });

  it('passes non-gateway entries through unchecked', () => {
    const entry: ProviderChainEntry = { provider: 'cli-bridge', model: 'whatever', apiKey: '' };
    const { valid, invalid } = validateProviderChain([entry], models, providers);
    expect(valid).toEqual([entry]);
    expect(invalid).toEqual([]);
  });

  it('rejects a provider-less model when targetProvider is set (no lenient escape)', () => {
    const entry = gatewayEntry({ targetProvider: 'codex-cli', model: 'gpt-orphan' });
    const orphanModels: GatewayModelEntry[] = [{ id: 'gpt-orphan' }]; // no provider field
    const { invalid } = validateProviderChain([entry], orphanModels, providers);
    expect(invalid[0]?.reason).toMatch(/not advertised by provider/);
  });

  it('fails OPEN on empty discovery (transient blip must not nuke the chain)', () => {
    const entry = gatewayEntry({ targetProvider: 'codex-cli', model: 'gpt-5.5' });
    const { valid, invalid } = validateProviderChain([entry], [], []);
    expect(valid).toEqual([entry]);
    expect(invalid).toEqual([]);
  });

  it('skips only the empty dimension (providers known, models empty)', () => {
    const entry = gatewayEntry({ targetProvider: 'codex-cli', model: 'gpt-5.5' });
    // models empty → model check skipped; provider still checked and valid
    expect(validateProviderChain([entry], [], providers).valid).toEqual([entry]);
    // unknown provider still rejected even with models empty
    const bad = gatewayEntry({ targetProvider: 'ghost', model: 'gpt-5.5' });
    expect(validateProviderChain([bad], [], providers).invalid).toHaveLength(1);
  });
});
