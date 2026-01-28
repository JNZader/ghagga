/**
 * Concept extraction for Hebbian learning
 * Identifies patterns and concepts in code and review content
 */

/**
 * Concept patterns for automatic detection
 * Maps concept names to regex patterns that identify them
 */
const CONCEPT_PATTERNS: Record<string, RegExp[]> = {
  security: [
    /\bauth\b/i,
    /\bpassword\b/i,
    /\btoken\b/i,
    /\bencrypt/i,
    /\bsql\b/i,
    /\bcredential/i,
    /\bsecret/i,
    /\bhash\b/i,
    /\bsanitize/i,
    /\bvalidat/i,
  ],
  database: [
    /\bquery\b/i,
    /\bselect\b/i,
    /\binsert\b/i,
    /\bmodel\b/i,
    /\bschema\b/i,
    /\btable\b/i,
    /\bindex\b/i,
    /\bmigration/i,
    /\bforeign\s*key/i,
    /\bprimary\s*key/i,
  ],
  performance: [
    /\bloop\b/i,
    /\bcache\b/i,
    /\basync\b/i,
    /\bpromise\b/i,
    /\bbatch\b/i,
    /\boptimiz/i,
    /\bmemoiz/i,
    /\blazy\b/i,
    /\bprofil/i,
    /\bbenchmark/i,
  ],
  api: [
    /\bendpoint\b/i,
    /\broute\b/i,
    /\bhandler\b/i,
    /\brequest\b/i,
    /\bresponse\b/i,
    /\brest\b/i,
    /\bgraphql\b/i,
    /\bwebhook\b/i,
    /\bmiddleware\b/i,
    /\bcontroller\b/i,
  ],
  error: [
    /\btry\b/i,
    /\bcatch\b/i,
    /\bthrow\b/i,
    /\berror\b/i,
    /\bexception\b/i,
    /\bfailure\b/i,
    /\bhandle\b/i,
    /\bfallback\b/i,
    /\bretry\b/i,
    /\brecover/i,
  ],
  testing: [
    /\btest\b/i,
    /\bdescribe\b/i,
    /\bit\b\s*\(/,
    /\bexpect\b/i,
    /\bmock\b/i,
    /\bstub\b/i,
    /\bspy\b/i,
    /\bassert\b/i,
    /\bfixture\b/i,
    /\bcoverage\b/i,
  ],
  typing: [
    /\binterface\b/i,
    /\btype\b\s+\w+\s*=/,
    /\benum\b/i,
    /\bgeneric/i,
    /\bextends\b/i,
    /\bimplements\b/i,
    /\bunion\b/i,
    /\bintersection\b/i,
    /\bReadonly\b/,
    /\bPartial\b/,
  ],
  async: [
    /\bawait\b/i,
    /\basync\b/i,
    /\bpromise\b/i,
    /\bcallback\b/i,
    /\bobservable\b/i,
    /\bsubscri/i,
    /\bevent\s*emitter/i,
    /\bstream\b/i,
    /\bconcurren/i,
    /\bparallel\b/i,
  ],
  config: [
    /\bconfig/i,
    /\benv\b/i,
    /\bsetting/i,
    /\boption/i,
    /\bflag\b/i,
    /\bparameter\b/i,
    /\bdefault\b/i,
    /\binitializ/i,
    /\bbootstrap/i,
    /\bsetup\b/i,
  ],
  logging: [
    /\blog\b/i,
    /\blogger\b/i,
    /\bdebug\b/i,
    /\binfo\b/i,
    /\bwarn\b/i,
    /\btrace\b/i,
    /\bmonitor/i,
    /\bmetric/i,
    /\btelemetry/i,
    /\baudit\b/i,
  ],
};

/**
 * Result of concept extraction
 */
export interface ConceptExtractionResult {
  concepts: string[];
  scores: Record<string, number>;
}

/**
 * Extract concepts from content by matching against known patterns
 * @param content - Text content to analyze (code, review comments, etc.)
 * @returns Array of identified concept names
 */
export function extractConcepts(content: string): string[] {
  const concepts: string[] = [];

  for (const [concept, patterns] of Object.entries(CONCEPT_PATTERNS)) {
    if (patterns.some((p) => p.test(content))) {
      concepts.push(concept);
    }
  }

  return concepts;
}

/**
 * Extract concepts with confidence scores based on pattern match frequency
 * @param content - Text content to analyze
 * @returns Object with concepts and their confidence scores
 */
export function extractConceptsWithScores(
  content: string
): ConceptExtractionResult {
  const scores: Record<string, number> = {};

  for (const [concept, patterns] of Object.entries(CONCEPT_PATTERNS)) {
    let matchCount = 0;
    for (const pattern of patterns) {
      const matches = content.match(new RegExp(pattern, 'gi'));
      if (matches) {
        matchCount += matches.length;
      }
    }

    if (matchCount > 0) {
      // Normalize score: more matches = higher confidence (capped at 1.0)
      scores[concept] = Math.min(1.0, matchCount / 10);
    }
  }

  const concepts = Object.keys(scores);

  return { concepts, scores };
}

/**
 * Extract concepts from multiple content sources and combine results
 * @param contents - Array of text content to analyze
 * @returns Combined concepts with aggregated scores
 */
export function extractConceptsFromMultiple(
  contents: string[]
): ConceptExtractionResult {
  const aggregatedScores: Record<string, number[]> = {};

  for (const content of contents) {
    const { scores } = extractConceptsWithScores(content);

    for (const [concept, score] of Object.entries(scores)) {
      if (!aggregatedScores[concept]) {
        aggregatedScores[concept] = [];
      }
      aggregatedScores[concept].push(score);
    }
  }

  // Average scores across all contents
  const scores: Record<string, number> = {};
  for (const [concept, conceptScores] of Object.entries(aggregatedScores)) {
    scores[concept] =
      conceptScores.reduce((a, b) => a + b, 0) / conceptScores.length;
  }

  const concepts = Object.keys(scores);

  return { concepts, scores };
}

/**
 * Get all available concept categories
 * @returns Array of concept category names
 */
export function getAvailableConcepts(): string[] {
  return Object.keys(CONCEPT_PATTERNS);
}
