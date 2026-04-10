import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateViaGateway } from './gateway.js';

describe('generateViaGateway', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('throws if gatewayUrl is missing', async () => {
    await expect(
      generateViaGateway('prompt', 'system', {
        gatewayUrl: '',
        gatewayToken: 'token',
      }),
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
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      tokensUsed: 500,
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await generateViaGateway('review this code', 'you are a reviewer', {
      gatewayUrl: 'https://llm-gateway.example.com',
      gatewayToken: 'test-token-123',
      model: 'auto',
      project: 'ghagga',
    });

    expect(result).toEqual(mockResponse);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, options] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://llm-gateway.example.com/v1/generate');
    expect(options?.method).toBe('POST');
    expect(options?.headers).toEqual(
      expect.objectContaining({
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-token-123',
      }),
    );

    const body = JSON.parse(options?.body as string);
    expect(body.prompt).toBe('review this code');
    expect(body.system).toBe('you are a reviewer');
    expect(body.model).toBe('auto');
    expect(body.project).toBe('ghagga');
  });

  it('throws on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    await expect(
      generateViaGateway('prompt', 'system', {
        gatewayUrl: 'https://example.com',
        gatewayToken: 'bad-token',
      }),
    ).rejects.toThrow('Gateway error (401): Unauthorized');
  });

  it('handles network errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network failed'));

    await expect(
      generateViaGateway('prompt', 'system', {
        gatewayUrl: 'https://example.com',
        gatewayToken: 'token',
      }),
    ).rejects.toThrow('Network failed');
  });

  it('sends without optional fields when not provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: 'ok', provider: 'groq', model: 'auto' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await generateViaGateway('prompt', undefined, {
      gatewayUrl: 'https://example.com',
      gatewayToken: 'token',
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string);
    expect(body.system).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect(body.project).toBeUndefined();
  });
});
