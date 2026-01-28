/**
 * OpenAI GPT provider implementation
 */

import type {
  ChatMessage,
  LLMRequestOptions,
  LLMResponse,
  LLMProvider,
  ModelInfo,
  TokenUsage,
} from '../types/index.ts';
import type { AIProvider } from './anthropic.ts';

/**
 * OpenAI API response types
 */
interface OpenAIMessage {
  role: 'assistant';
  content: string | null;
}

interface OpenAIChoice {
  index: number;
  message: OpenAIMessage;
  finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null;
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
}

interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}

/**
 * OpenAI GPT provider
 */
export class OpenAIProvider implements AIProvider {
  readonly name: LLMProvider = 'openai';
  readonly models = [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-4',
    'gpt-3.5-turbo',
  ];

  private readonly baseUrl = 'https://api.openai.com/v1';

  private readonly modelInfoMap: Map<string, ModelInfo> = new Map([
    [
      'gpt-4o',
      {
        id: 'gpt-4o',
        provider: 'openai',
        name: 'GPT-4o',
        contextWindow: 128000,
        maxOutputTokens: 4096,
        supportsVision: true,
        supportsTools: true,
      },
    ],
    [
      'gpt-4o-mini',
      {
        id: 'gpt-4o-mini',
        provider: 'openai',
        name: 'GPT-4o Mini',
        contextWindow: 128000,
        maxOutputTokens: 16384,
        supportsVision: true,
        supportsTools: true,
      },
    ],
    [
      'gpt-4-turbo',
      {
        id: 'gpt-4-turbo',
        provider: 'openai',
        name: 'GPT-4 Turbo',
        contextWindow: 128000,
        maxOutputTokens: 4096,
        supportsVision: true,
        supportsTools: true,
      },
    ],
    [
      'gpt-4',
      {
        id: 'gpt-4',
        provider: 'openai',
        name: 'GPT-4',
        contextWindow: 8192,
        maxOutputTokens: 4096,
        supportsVision: false,
        supportsTools: true,
      },
    ],
    [
      'gpt-3.5-turbo',
      {
        id: 'gpt-3.5-turbo',
        provider: 'openai',
        name: 'GPT-3.5 Turbo',
        contextWindow: 16385,
        maxOutputTokens: 4096,
        supportsVision: false,
        supportsTools: true,
      },
    ],
  ]);

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const apiKey = Deno.env.get('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const model = options.model || this.models[0];
    const messages = this.formatMessages(options.messages);

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: options.maxTokens ?? 4096,
    };

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    if (options.topP !== undefined) {
      body.top_p = options.topP;
    }

    if (options.stop && options.stop.length > 0) {
      body.stop = options.stop;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as OpenAIError;
      throw new Error(
        `OpenAI API error: ${errorData.error?.message || response.statusText}`
      );
    }

    const data = (await response.json()) as OpenAIResponse;

    return this.formatResponse(data);
  }

  async isAvailable(): Promise<boolean> {
    return !!Deno.env.get('OPENAI_API_KEY');
  }

  getModelInfo(modelId: string): ModelInfo | undefined {
    return this.modelInfoMap.get(modelId);
  }

  private formatMessages(
    messages: ChatMessage[]
  ): Array<{ role: string; content: string }> {
    return messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  private formatResponse(data: OpenAIResponse): LLMResponse {
    const choice = data.choices[0];
    const content = choice?.message?.content || '';

    const usage: TokenUsage = {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    };

    let finishReason: LLMResponse['finishReason'];
    switch (choice?.finish_reason) {
      case 'stop':
        finishReason = 'stop';
        break;
      case 'length':
        finishReason = 'length';
        break;
      case 'content_filter':
        finishReason = 'content_filter';
        break;
      case 'tool_calls':
        finishReason = 'tool_calls';
        break;
      default:
        finishReason = undefined;
    }

    return {
      content,
      model: data.model,
      usage,
      finishReason,
    };
  }
}
