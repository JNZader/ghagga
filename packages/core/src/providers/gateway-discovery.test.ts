import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderChainEntry } from '../types.js';
import {
  fetchGatewayModels,
  fetchGatewayProviders,
  type GatewayModelEntry,
  type GatewayProviderStatus,
  validateProviderChain,
} from './gateway-discovery.js';

const URL = 'https://llm-gateway.example.com';
const TOKEN = 'test-token';

function gatewayEntry(over: Partial<ProviderChainEntry> = {}): ProviderChainEntry {
  return { provider: 'gateway', model: 'auto', apiKey: '', gatewayUrl: URL, ...over };
}

describe('fetchGatewayModels', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns the data array from GET /v1/models with auth', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.5', provider: 'codex-cli' }] }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const models = await fetchGatewayModels(URL, TOKEN);
    expect(models).toEqual([{ id: 'gpt-5.5', provider: 'codex-cli' }]);

    const [url, options] = spy.mock.calls[0] ?? [];
    expect(url).toBe(`${URL}/v1/models`);
    expect(options?.method).toBe('GET');
    expect(options?.redirect).toBe('manual');
    expect(options?.headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }));
  });

  it('returns [] when data is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ object: 'list' }), { status: 200 }),
    );
    expect(await fetchGatewayModels(URL, TOKEN)).toEqual([]);
  });

  it('filters out malformed entries (no string id)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [null, { id: 'gpt-5.5' }, { nope: 1 }, 42] }), {
        status: 200,
      }),
    );
    expect(await fetchGatewayModels(URL, TOKEN)).toEqual([{ id: 'gpt-5.5' }]);
  });

  it('throws on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(fetchGatewayModels(URL, TOKEN)).rejects.toThrow('Gateway error (500)');
  });

  it('throws when URL is missing', async () => {
    await expect(fetchGatewayModels('', TOKEN)).rejects.toThrow('Gateway URL not configured');
  });
});

describe('fetchGatewayProviders', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns the providers array from GET /v1/providers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          providers: [{ id: 'codex-cli', name: 'Codex', type: 'cli', available: true }],
        }),
        {
          status: 200,
        },
      ),
    );
    const providers = await fetchGatewayProviders(URL, TOKEN);
    expect(providers).toEqual([{ id: 'codex-cli', name: 'Codex', type: 'cli', available: true }]);
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
