/**
 * GitHub Webhook Handler Edge Function
 *
 * Receives webhooks from GitHub, verifies signatures, and routes events
 * to appropriate handlers for processing.
 */

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts';
import { corsHeaders } from '../_shared/cors.ts';
import type {
  GitHubEventName,
  GitHubWebhookPayload,
  PullRequestEventPayload,
  InstallationEventPayload,
  InstallationRepositoriesEventPayload,
} from '../_shared/types/index.ts';
import { handlePullRequest } from './handlers/pull_request.ts';
import { handleInstallation, handleInstallationRepositories } from './handlers/installation.ts';

/**
 * Verify GitHub webhook signature using HMAC-SHA256
 *
 * @param payload - Raw request body
 * @param signature - x-hub-signature-256 header value
 * @param secret - Webhook secret from environment
 * @returns True if signature is valid
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) {
    return false;
  }

  // Signature format: sha256=<hex>
  const parts = signature.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') {
    return false;
  }

  const receivedSignature = parts[1];

  // Create HMAC-SHA256 signature
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload)
  );

  // Convert to hex string
  const expectedSignature = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison to prevent timing attacks
  return timingSafeEqual(receivedSignature, expectedSignature);
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

/**
 * PR actions that trigger code review
 */
const REVIEW_TRIGGER_ACTIONS = ['opened', 'synchronize', 'reopened'];

/**
 * Check if a PR event should trigger a review
 */
export function shouldTriggerReview(payload: PullRequestEventPayload): boolean {
  // Only trigger on specific actions
  if (!REVIEW_TRIGGER_ACTIONS.includes(payload.action)) {
    return false;
  }

  // Don't review draft PRs
  if (payload.pull_request.draft) {
    return false;
  }

  // Don't review closed/merged PRs
  if (payload.pull_request.state !== 'open') {
    return false;
  }

  return true;
}

/**
 * Create an error response with proper headers
 */
function errorResponse(message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: message }),
    {
      status,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    }
  );
}

/**
 * Create a success response with proper headers
 */
function successResponse(data: unknown, status = 200): Response {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    }
  );
}

/**
 * Main webhook handler
 */
serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  const deliveryId = req.headers.get('x-github-delivery') || 'unknown';

  try {
    // Get webhook secret from environment
    const webhookSecret = Deno.env.get('GITHUB_WEBHOOK_SECRET');
    if (!webhookSecret) {
      console.error(`[${deliveryId}] GITHUB_WEBHOOK_SECRET not configured`);
      return errorResponse('Webhook secret not configured', 500);
    }

    // Read and verify request body
    const body = await req.text();

    // Verify signature
    const signature = req.headers.get('x-hub-signature-256');
    const isValid = await verifyWebhookSignature(body, signature, webhookSecret);

    if (!isValid) {
      console.warn(`[${deliveryId}] Invalid webhook signature`);
      return errorResponse('Invalid signature', 401);
    }

    // Parse payload
    let payload: GitHubWebhookPayload;
    try {
      payload = JSON.parse(body);
    } catch {
      console.error(`[${deliveryId}] Invalid JSON payload`);
      return errorResponse('Invalid JSON payload', 400);
    }

    // Get event type
    const event = req.headers.get('x-github-event') as GitHubEventName | null;
    if (!event) {
      console.warn(`[${deliveryId}] Missing x-github-event header`);
      return errorResponse('Missing event header', 400);
    }

    console.log(`[${deliveryId}] Received ${event} event, action: ${payload.action}`);

    // Route to appropriate handler
    switch (event) {
      case 'pull_request': {
        const prPayload = payload as PullRequestEventPayload;

        // Check if we should trigger a review
        if (!shouldTriggerReview(prPayload)) {
          console.log(
            `[${deliveryId}] PR event ${prPayload.action} does not trigger review`
          );
          return successResponse({
            message: 'Event acknowledged but no action required',
            action: prPayload.action,
            reason: 'action_not_triggering',
          });
        }

        // Handle the pull request
        const result = await handlePullRequest(prPayload, deliveryId);
        return successResponse(result);
      }

      case 'installation': {
        const installPayload = payload as InstallationEventPayload;
        const result = await handleInstallation(installPayload, deliveryId);
        return successResponse(result);
      }

      case 'installation_repositories': {
        const reposPayload = payload as InstallationRepositoriesEventPayload;
        const result = await handleInstallationRepositories(reposPayload, deliveryId);
        return successResponse(result);
      }

      default:
        // Log but don't error on unhandled events
        console.log(`[${deliveryId}] Event ${event} not handled, ignoring`);
        return successResponse({
          message: 'Event ignored',
          event,
        });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[${deliveryId}] Webhook handler error:`, errorMessage);

    // Don't expose internal errors to clients
    return errorResponse('Internal server error', 500);
  }
});
