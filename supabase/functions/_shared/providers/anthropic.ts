/**
 * Anthropic Claude provider implementation
 */

import type {
  ChatMessage,
  LLMRequestOptions,
  LLMResponse,
  LLMProvider,
  ModelInfo,
  TokenUsage,
} from '../types/index.ts';

/**
 * AI Provider interface that all providers must implement
 */
export interface AIProvider {
  readonly name: LLMProvider;
  readonly models: string[];
  complete(options: LLMRequestOptions): Promise<LLMResponse>;
  isAvailable(): Promise<boolean>;
  getModelInfo(modelId: string): ModelInfo | undefined;
}

/**
 * Anthropic API response types
 */
interface AnthropicContentBlock {
  type: 'text';
  text: string;
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | null;
  usage: AnthropicUsage;
}

interface AnthropicError {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

/**
 * Anthropic Claude provider
 */
export class AnthropicProvider implements AIProvider {
  readonly name: LLMProvider = 'anthropic';
  readonly models = [
    'claude-opus-4-5-20251101',
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
  ];

  private readonly baseUrl = 'https://api.anthropic.com/v1';
  private readonly apiVersion = '2023-06-01';

  private readonly modelInfoMap: Map<string, ModelInfo> = new Map([
    [
      'claude-opus-4-5-20251101',
      {
        id: 'claude-opus-4-5-20251101',
        provider: 'anthropic',
        name: 'Claude Opus 4.5',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        supportsVision: true,
        supportsTools: true,
      },
    ],
    [
      'claude-sonnet-4-20250514',
      {
        id: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        name: 'Claude Sonnet 4',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        supportsVision: true,
        supportsTools: true,
      },
    ],
    [
      'claude-3-5-sonnet-20241022',
      {
        id: 'claude-3-5-sonnet-20241022',
        provider: 'anthropic',
        name: 'Claude 3.5 Sonnet',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        supportsVision: true,
        supportsTools: true,
      },
    ],
    [
      'claude-3-5-haiku-20241022',
      {
        id: 'claude-3-5-haiku-20241022',
        provider: 'anthropic',
        name: 'Claude 3.5 Haiku',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        supportsVision: true,
        supportsTools: true,
      },
    ],
  ]);

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is not set');
    }

    const model = options.model || this.models[0];
    const { systemMessage, userMessages } = this.extractMessages(options.messages);

    const body: Record<string, unknown> = {
      model,
      max_tokens: options.maxTokens ?? 4096,
      messages: userMessages,
    };

    if (systemMessage) {
      body.system = systemMessage;
    }

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    if (options.topP !== undefined) {
      body.top_p = options.topP;
    }

    if (options.stop && options.stop.length > 0) {
      body.stop_sequences = options.stop;
    }

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': this.apiVersion,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as AnthropicError;
      throw new Error(
        `Anthropic API error: ${errorData.error?.message || response.statusText}`
      );
    }

    const data = (await response.json()) as AnthropicResponse;

    return this.formatResponse(data);
  }

  async isAvailable(): Promise<boolean> {
    return !!Deno.env.get('ANTHROPIC_API_KEY');
  }

  getModelInfo(modelId: string): ModelInfo | undefined {
    return this.modelInfoMap.get(modelId);
  }

  private extractMessages(messages: ChatMessage[]): {
    systemMessage: string | null;
    userMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  } {
    let systemMessage: string | null = null;
    const userMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessage = msg.content;
      } else {
        userMessages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    return { systemMessage, userMessages };
  }

  private formatResponse(data: AnthropicResponse): LLMResponse {
    const content = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const usage: TokenUsage = {
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
      totalTokens: data.usage.input_tokens + data.usage.output_tokens,
    };

    let finishReason: LLMResponse['finishReason'];
    switch (data.stop_reason) {
      case 'end_turn':
      case 'stop_sequence':
        finishReason = 'stop';
        break;
      case 'max_tokens':
        finishReason = 'length';
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
