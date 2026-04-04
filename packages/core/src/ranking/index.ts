import type { EmbeddingProvider } from '../embed.js';
import { cosineSimilarity } from '../embed.js';
import type { ReviewFinding } from '../types.js';

// Reference text that represents "high priority review concern"
// This is a fixed reference — we embed it once and compare all findings to it
const HIGH_PRIORITY_REF =
  'critical security vulnerability authentication bypass memory corruption data exposure injection attack';

// File paths that get a context boost (auth, security, payment critical paths)
const HIGH_PRIORITY_PATTERNS = [
  /auth/i,
  /security/i,
  /payment/i,
  /credential/i,
  /token/i,
  /secret/i,
  /password/i,
  /crypto/i,
  /encrypt/i,
  /session/i,
];

const CONTEXT_BOOST = 0.2;

/**
 * Severity numeric weight (higher = more important).
 */
function severityWeight(severity?: string): number {
  switch (severity?.toLowerCase()) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default:
      return 1;
  }
}

/**
 * Check if a file path matches any high-priority pattern.
 */
function hasContextBoost(filePath?: string): boolean {
  if (!filePath) return false;
  return HIGH_PRIORITY_PATTERNS.some((p) => p.test(filePath));
}

/**
 * Build a text representation of a finding for embedding.
 * ReviewFinding uses `message` as the primary text field (no `title` or `description`).
 */
function findingToText(f: ReviewFinding): string {
  return [f.message ?? '', f.category ?? '', f.file ?? ''].filter(Boolean).join(' ');
}

/**
 * Rerank findings using embedding similarity to HIGH_PRIORITY_REF.
 * Combined score = severity_weight × (cosine_similarity + context_boost)
 * Falls back to original order if embeddingProvider is not available.
 */
export async function rankFindings(
  findings: ReviewFinding[],
  embeddingProvider: EmbeddingProvider | null | undefined,
): Promise<ReviewFinding[]> {
  if (!embeddingProvider || findings.length <= 1) {
    return findings;
  }

  try {
    // Embed all findings + reference in one batch
    const texts = [HIGH_PRIORITY_REF, ...findings.map(findingToText)];
    const embeddings = await embeddingProvider.embedBatch(texts);

    const refEmbedding = embeddings[0]!;
    const findingEmbeddings = embeddings.slice(1);

    const scored = findings.map((finding, i) => {
      const embedding = findingEmbeddings[i]!;
      const similarity = cosineSimilarity(refEmbedding, embedding);
      const boost = hasContextBoost(finding.file) ? CONTEXT_BOOST : 0;
      const relevance = Math.min(1, similarity + boost);
      const combined = severityWeight(finding.severity) * relevance;
      return { finding, combined };
    });

    scored.sort((a, b) => b.combined - a.combined);
    return scored.map((s) => s.finding);
  } catch {
    // Non-fatal — return original order on any error
    return findings;
  }
}
