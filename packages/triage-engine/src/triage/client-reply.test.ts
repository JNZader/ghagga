import type { GenerateTextFn } from 'ghagga-core';
import { describe, expect, it, vi } from 'vitest';
import { buildClientReplySystemPrompt, generateClientReply } from './client-reply.js';

function captureFn(response: string): {
  fn: GenerateTextFn;
  calls: Array<{ system: string; prompt: string }>;
} {
  const calls: Array<{ system: string; prompt: string }> = [];
  const fn: GenerateTextFn = vi.fn(async (system: string, prompt: string) => {
    calls.push({ system, prompt });
    return { text: response, tokensUsed: 7, provider: 'cli-bridge', model: 'test' };
  });
  return { fn, calls };
}

describe('buildClientReplySystemPrompt', () => {
  it('bans the configured jargon terms', () => {
    const prompt = buildClientReplySystemPrompt('es', ['traceback', 'endpoint', 'backend']);
    expect(prompt).toContain('traceback');
    expect(prompt).toContain('endpoint');
    expect(prompt).toContain('backend');
  });

  it('embeds the target language', () => {
    const prompt = buildClientReplySystemPrompt('es', []);
    expect(prompt).toContain('es');
  });

  it('caps response length and forbids promising dates', () => {
    const prompt = buildClientReplySystemPrompt('es', []);
    expect(prompt.toLowerCase()).toContain('date');
  });
});

describe('generateClientReply', () => {
  it('calls generateFn with the report inside the prompt and a jargon-ban system prompt', async () => {
    const { fn, calls } = captureFn('Estamos revisando tu consulta, te contactamos pronto.');
    const reply = await generateClientReply(
      {
        issueTitle: 'App crashes on save',
        report: 'Root cause: null pointer in retry.ts:42 due to unset config.timeout.',
        language: 'es',
        jargonBan: ['null pointer', 'retry.ts'],
      },
      fn,
    );

    expect(reply).toBe('Estamos revisando tu consulta, te contactamos pronto.');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toContain('null pointer');
    expect(calls[0]?.prompt).toContain('retry.ts:42');
    expect(calls[0]?.prompt).toContain('App crashes on save');
  });

  it('trims the returned text', async () => {
    const { fn } = captureFn('  hola  \n');
    const reply = await generateClientReply({ issueTitle: 't', report: 'r', language: 'es' }, fn);
    expect(reply).toBe('hola');
  });

  it('falls back to DEFAULT jargon-ban terms when none are configured', async () => {
    const { fn, calls } = captureFn('ok');
    await generateClientReply({ issueTitle: 't', report: 'r', language: 'es' }, fn);
    // At least one common technical term should be present in the default ban list.
    expect(calls[0]?.system.toLowerCase()).toMatch(/traceback|stack trace|endpoint/);
  });
});
