import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGroqGenerateFn, GROQ_BASE_URL } from './groq.js';

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

describe('createGroqGenerateFn', () => {
  const chat = vi.fn((modelId: string) => ({ modelId }));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createOpenAI).mockReturnValue(Object.assign(vi.fn(), { chat }) as never);
    vi.mocked(generateText).mockResolvedValue({
      text: 'STATUS: PASSED\nSUMMARY: ok\n',
      usage: { inputTokens: 3, outputTokens: 4 },
    } as never);
  });

  it('calls Groq chat completions with the API key and model', async () => {
    const generate = createGroqGenerateFn('openai/gpt-oss-120b', 'gsk_test');
    const result = await generate('system', 'prompt');

    expect(createOpenAI).toHaveBeenCalledWith({
      baseURL: GROQ_BASE_URL,
      apiKey: 'gsk_test',
    });
    expect(chat).toHaveBeenCalledWith('openai/gpt-oss-120b');
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ system: 'system', prompt: 'prompt' }),
    );
    expect(result).toEqual({
      text: 'STATUS: PASSED\nSUMMARY: ok\n',
      tokensUsed: 7,
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
    });
  });
});
