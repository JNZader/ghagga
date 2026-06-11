/**
 * Structured Memory Taxonomy
 *
 * Classifies memory observations into semantic categories so future
 * reviews can understand the nature of each stored observation at a glance.
 */

// ─── Types ──────────────────────────────────────────────────────

export type MemoryCategory =
  | 'fact'
  | 'preference'
  | 'relationship'
  | 'skill'
  | 'bug_pattern'
  | 'decision'
  | 'constraint';

export interface TaxonomyTag {
  category: MemoryCategory;
  confidence: number; // 0-1
  evidence: string; // the text that led to this classification
}

// ─── Keyword Rules ───────────────────────────────────────────────

interface CategoryRule {
  category: MemoryCategory;
  keywords: string[];
  weight: number;
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: 'constraint',
    keywords: [
      'cannot',
      'must not',
      'must-not',
      'limit',
      'restriction',
      'forbidden',
      'prohibited',
      'disallowed',
      'not allowed',
    ],
    weight: 1.0,
  },
  {
    category: 'decision',
    keywords: [
      'decided',
      'chose',
      'chosen',
      'reason',
      'because',
      'trade-off',
      'tradeoff',
      'rationale',
      'opted',
      'selected',
    ],
    weight: 0.9,
  },
  {
    category: 'bug_pattern',
    keywords: [
      'bug',
      'error',
      'issue',
      'crash',
      'null',
      'undefined',
      'race condition',
      'deadlock',
      'memory leak',
      'exception',
      'throws',
      'fails',
      'broken',
    ],
    weight: 0.9,
  },
  {
    category: 'preference',
    keywords: [
      'prefer',
      'should',
      'always',
      'never',
      'convention',
      'recommended',
      'best practice',
      'avoid',
      'favor',
      'instead of',
      'use X over',
    ],
    weight: 0.85,
  },
  {
    category: 'skill',
    keywords: [
      'pattern',
      'approach',
      'technique',
      'strategy',
      'how to',
      'method',
      'algorithm',
      'recipe',
      'template',
    ],
    weight: 0.8,
  },
  {
    category: 'relationship',
    keywords: [
      'depends on',
      'calls',
      // NOTE: the bare verb 'uses' is intentionally NOT a relationship keyword.
      // "X uses Y" is a factual statement ("the auth module uses JWT"), not a
      // structural relationship. It lived in BOTH this rule and 'fact', and
      // since rules are evaluated in order, relationship (higher up) wrongly
      // won every factual "uses" sentence. Relationship keywords are reserved
      // for explicit structural verbs (inherits/extends/imports/…).
      'inherits',
      'extends',
      'implements',
      'imports',
      'requires',
      'connected to',
      'linked to',
      'belongs to',
    ],
    weight: 0.8,
  },
  {
    category: 'fact',
    keywords: [
      'uses',
      'is',
      'returns',
      'stores',
      'contains',
      'has',
      'provides',
      'exposes',
      'exports',
    ],
    weight: 0.5,
  },
];

// ─── Implementation ──────────────────────────────────────────────

/**
 * Classify an observation into a memory category using keyword matching.
 *
 * Rules are evaluated in priority order (highest weight first).
 * The first category whose keywords appear in the content or title wins.
 *
 * @param content - The observation content text
 * @param title - The observation title
 * @returns TaxonomyTag with category, confidence, and matched evidence
 */
export function classifyObservation(content: string, title: string): TaxonomyTag {
  const combined = `${title} ${content}`.toLowerCase();

  // Evaluate rules in weight order (already sorted above)
  for (const rule of CATEGORY_RULES) {
    for (const keyword of rule.keywords) {
      if (combined.includes(keyword.toLowerCase())) {
        // Compute confidence: weight * (0.7 if only title, 0.9 if in content, 1.0 if both)
        const inTitle = title.toLowerCase().includes(keyword.toLowerCase());
        const inContent = content.toLowerCase().includes(keyword.toLowerCase());
        let confidence = rule.weight;
        if (inTitle && inContent) confidence = Math.min(1.0, rule.weight * 1.1);
        else if (inTitle) confidence = rule.weight * 0.85;
        // else content only — base weight

        return {
          category: rule.category,
          confidence: Math.round(confidence * 100) / 100,
          evidence: keyword,
        };
      }
    }
  }

  // Default fallback
  return {
    category: 'fact',
    confidence: 0.3,
    evidence: '(default classification)',
  };
}

/**
 * Format taxonomy tags for injection into LLM prompts.
 *
 * Produces a compact section listing observation categories and confidence
 * so the agent can prioritize/filter memory context appropriately.
 *
 * @param tags - Array of taxonomy tags for the current observation set
 * @returns Formatted string for prompt injection
 */
export function formatTaxonomyPrompt(tags: TaxonomyTag[]): string {
  if (tags.length === 0) return '';

  const lines: string[] = [
    '## Memory Classification',
    '',
    'Observations have been classified by type:',
    '',
  ];

  for (const tag of tags) {
    const confidencePct = Math.round(tag.confidence * 100);
    lines.push(
      `- **[${tag.category.toUpperCase().replace('_', ' ')}]** (confidence: ${confidencePct}%, evidence: "${tag.evidence}")`,
    );
  }

  lines.push('');
  return lines.join('\n');
}
