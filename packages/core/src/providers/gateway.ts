/**
 * LLM Gateway provider — delegates LLM calls to a centralized gateway service.
 *
 * The gateway URL and token are configured per-installation via the dashboard
 * (stored in the provider chain entry). No environment variables needed.
 *
 * API contract:
 *   POST /v1/generate
 *   Request:  { prompt, system, provider?, model?, project? }
 *   Response: { text, provider, model, tokensUsed }
 *
 * This provider bypasses the AI SDK entirely — the gateway handles model
 * selection, provider routing, and token management internally.
 */

// ─── Types ──────────────────────────────────────────────────────

export interface GatewayOptions {
  /** Gateway base URL (e.g., "https://llm-gateway.javierzader.com") */
  gatewayUrl: string;
  /** Bearer token for gateway authentication */
  gatewayToken: string;
  /** Model to request (optional — gateway can auto-select) */
  model?: string;
  /** Project identifier for gateway tracking/routing */
  project?: string;
}

export interface GatewayResponse {
  text: string;
  provider: string;
  model: string;
  tokensUsed?: number;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Generate text via the LLM Gateway.
 *
 * @param prompt - User prompt (typically includes the diff)
 * @param systemPrompt - System prompt (review instructions, context, etc.)
 * @param options - Gateway connection options (URL, token, model, project)
 * @returns Gateway response with generated text and metadata
 */
export async function generateViaGateway(
  prompt: string,
  systemPrompt?: string,
  options?: GatewayOptions,
): Promise<GatewayResponse> {
  const { gatewayUrl, gatewayToken, model, project } = options ?? {};

  if (!gatewayUrl) {
    throw new Error('Gateway URL not configured — set it in the dashboard provider chain settings');
  }
  if (!gatewayToken) {
    throw new Error(
      'Gateway token not configured — set the API key in the dashboard provider chain settings',
    );
  }

  const response = await fetch(`${gatewayUrl}/v1/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${gatewayToken}`,
    },
    body: JSON.stringify({
      prompt,
      system: systemPrompt,
      model,
      project,
    }),
    signal: AbortSignal.timeout(180_000), // 3 min timeout (matches CLI bridge)
    // SSRF defense: never follow redirects. The gateway URL was validated by
    // the server worker (safe-url) against the ORIGINAL host only; a 3xx
    // Location could redirect this server-side fetch to an unvalidated
    // private/loopback/metadata address. With redirect:'manual' a 3xx becomes
    // a non-ok response and is handled below as a failed generation, exactly
    // like any other gateway error.
    redirect: 'manual',
  });

  // Non-2xx (including a refused 3xx redirect) is a failed generation.
  if (!response.ok) {
    const error = await response.text().catch(() => 'unknown error');
    throw new Error(`Gateway error (${response.status}): ${error}`);
  }

  return response.json() as Promise<GatewayResponse>;
}
