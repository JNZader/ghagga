/**
 * Google Gemini provider implementation
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
 * Gemini API response types
 */
interface GeminiContent {
  parts: Array<{ text: string }>;
  role: 'user' | 'model';
}

interface GeminiCandidate {
  content: GeminiContent;
  finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER';
  index: number;
}

interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

interface GeminiResponse {
  candidates: GeminiCandidate[];
  usageMetadata: GeminiUsageMetadata;
  modelVersion: string;
}

interface GeminiError {
  error: {
    code: number;
    message: string;
    status: string;
  };
}

/**
 * Google Gemini provider
 */
export class GeminiProvider implements AIProvider {
  readonly name: LLMProvider = 'google';
  readonly models = [
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
    'gemini-2.0-flash-exp',
  ];

  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  private readonly modelInfoMap: Map<string, ModelInfo> = new Map([
    [
      'gemini-1.5-pro',
      {
        id: 'gemini-1.5-pro',
        provider: 'google',
        name: 'Gemini 1.5 Pro',
        contextWindow: 2097152,
        maxOutputTokens: 8192,
        supportsVision: true,
        supportsTools: true,
      },
    ],
    [
      'gemini-1.5-flash',
      {
        id: 'gemini-1.5-flash',
        provider: 'google',
        name: 'Gemini 1.5 Flash',
        contextWindow: 1048576,
        maxOutputTokens: 8192,
        supportsVision: true,
        supportsTools: true,
      },
    ],
    [
      'gemini-1.5-flash-8b',
      {
        id: 'gemini-1.5-flash-8b',
        provider: 'google',
        name: 'Gemini 1.5 Flash 8B',
        contextWindow: 1048576,
        maxOutputTokens: 8192,
        supportsVision: true,
        supportsTools: true,
      },
    ],
    [
      'gemini-2.0-flash-exp',
      {
        id: 'gemini-2.0-flash-exp',
        provider: 'google',
        name: 'Gemini 2.0 Flash Experimental',
        contextWindow: 1048576,
        maxOutputTokens: 8192,
        supportsVision: true,
        supportsTools: true,
      },
    ],
  ]);

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const apiKey = Deno.env.get('GOOGLE_API_KEY');
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY environment variable is not set');
    }

    const model = options.model || this.models[0];
    const { systemInstruction, contents } = this.formatMessages(options.messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? 4096,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    if (options.temperature !== undefined) {
      (body.generationConfig as Record<string, unknown>).temperature =
        options.temperature;
    }

    if (options.topP !== undefined) {
      (body.generationConfig as Record<string, unknown>).topP = options.topP;
    }

    if (options.stop && options.stop.length > 0) {
      (body.generationConfig as Record<string, unknown>).stopSequences = options.stop;
    }

    const url = `${this.baseUrl}/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = (await response.json()) as GeminiError;
      throw new Error(
        `Gemini API error: ${errorData.error?.message || response.statusText}`
      );
    }

    const data = (await response.json()) as GeminiResponse;

    return this.formatResponse(data, model);
  }

  async isAvailable(): Promise<boolean> {
    return !!Deno.env.get('GOOGLE_API_KEY');
  }

  getModelInfo(modelId: string): ModelInfo | undefined {
    return this.modelInfoMap.get(modelId);
  }

  private formatMessages(messages: ChatMessage[]): {
    systemInstruction: string | null;
    contents: GeminiContent[];
  } {
    let systemInstruction: string | null = null;
    const contents: GeminiContent[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = msg.content;
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    return { systemInstruction, contents };
  }

  private formatResponse(data: GeminiResponse, model: string): LLMResponse {
    const candidate = data.candidates[0];
    const content =
      candidate?.content?.parts?.map((p) => p.text).join('') || '';

    const usage: TokenUsage = {
      promptTokens: data.usageMetadata?.promptTokenCount || 0,
      completionTokens: data.usageMetadata?.candidatesTokenCount || 0,
      totalTokens: data.usageMetadata?.totalTokenCount || 0,
    };

    let finishReason: LLMResponse['finishReason'];
    switch (candidate?.finishReason) {
      case 'STOP':
        finishReason = 'stop';
        break;
      case 'MAX_TOKENS':
        finishReason = 'length';
        break;
      case 'SAFETY':
        finishReason = 'content_filter';
        break;
      default:
        finishReason = undefined;
    }

    return {
      content,
      model: data.modelVersion || model,
      usage,
      finishReason,
    };
  }
}
