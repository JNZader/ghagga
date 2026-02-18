/**
 * Memory Service - Engram-style persistent memory for code reviews
 *
 * Manages memory sessions (1 PR = 1 session) and structured observations.
 * Provides pre-review context consultation and post-review observation extraction.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { EmbeddingService } from '../embeddings/service.ts';
import { stripPrivacy } from './privacy.ts';
import type {
  ObservationType,
  MemoryObservation,
  MemoryContext,
  MemoryStats,
  AddObservationParams,
} from '../types/memory.ts';

interface ReviewFindingInput {
  severity: 'error' | 'warning' | 'info' | 'suggestion';
  category: string;
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export class MemoryService {
  private supabase: SupabaseClient;
  private embeddingService: EmbeddingService;

  constructor(supabase: SupabaseClient, embeddingService: EmbeddingService) {
    this.supabase = supabase;
    this.embeddingService = embeddingService;
  }

  /**
   * Start a new memory session for a PR review
   */
  async startSession(
    repoFullName: string,
    installationId: number,
    prNumber: number,
    prTitle: string
  ): Promise<string> {
    const sessionName = `PR #${prNumber}: ${prTitle}`;

    const { data, error } = await this.supabase
      .from('memory_sessions')
      .insert({
        installation_id: installationId,
        repo_full_name: repoFullName,
        pr_number: prNumber,
        session_name: sessionName,
        status: 'active',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to start memory session: ${error.message}`);
    }

    return data.id;
  }

  /**
   * Close a memory session with an optional summary
   */
  async closeSession(sessionId: string, summary?: string): Promise<void> {
    let finalSummary = summary;

    // Auto-generate summary from session observations if not provided
    if (!finalSummary) {
      const { data: observations } = await this.supabase
        .from('memory_observations')
        .select('observation_type, title, what_was_learned')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true });

      if (observations && observations.length > 0) {
        const lines = observations.map(
          (obs: { observation_type: string; title: string; what_was_learned: string | null }) =>
            `[${obs.observation_type}] ${obs.title}${obs.what_was_learned ? ': ' + obs.what_was_learned : ''}`
        );
        finalSummary = lines.join('\n');
      } else {
        finalSummary = 'No observations recorded.';
      }
    }

    // Generate embedding for the summary
    let summaryEmbedding: number[] | undefined;
    try {
      const result = await this.embeddingService.embed(finalSummary);
      summaryEmbedding = result.embedding;
    } catch {
      console.warn('Failed to generate embedding for session summary');
    }

    const { error } = await this.supabase
      .from('memory_sessions')
      .update({
        status: 'closed',
        summary: finalSummary,
        summary_embedding: summaryEmbedding,
        closed_at: new Date().toISOString(),
      })
      .eq('id', sessionId);

    if (error) {
      throw new Error(`Failed to close memory session: ${error.message}`);
    }
  }

  /**
   * Add a structured observation to the current session
   */
  async addObservation(params: AddObservationParams): Promise<string> {
    // Strip sensitive data
    const contentStripped = stripPrivacy(params.content);

    // Generate embedding
    let embedding: number[] | undefined;
    try {
      const embeddingText = [
        params.whatHappened,
        params.whatWasLearned,
        params.title,
      ]
        .filter(Boolean)
        .join(' ');
      const result = await this.embeddingService.embed(embeddingText || contentStripped);
      embedding = result.embedding;
    } catch {
      console.warn('Failed to generate embedding for observation');
    }

    const { data, error } = await this.supabase
      .from('memory_observations')
      .insert({
        session_id: params.sessionId,
        installation_id: params.installationId,
        repo_full_name: params.repoFullName,
        observation_type: params.observationType,
        title: params.title,
        content: params.content,
        content_stripped: contentStripped,
        what_happened: params.whatHappened,
        why_it_matters: params.whyItMatters,
        where_in_code: params.whereInCode,
        what_was_learned: params.whatWasLearned,
        tags: params.tags || [],
        embedding,
        confidence: params.confidence ?? 0.5,
        metadata: params.metadata || {},
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to add observation: ${error.message}`);
    }

    return data.id;
  }

  /**
   * Consult past memory before a review.
   * This is the key pre-review method - searches for relevant past observations.
   */
  async consultMemory(
    repoFullName: string,
    queryText: string,
    options?: { observationType?: ObservationType; limit?: number }
  ): Promise<MemoryContext> {
    const limit = options?.limit ?? 10;

    // Generate embedding for the query
    let queryEmbedding: number[] | undefined;
    try {
      const result = await this.embeddingService.embed(queryText.slice(0, 1000));
      queryEmbedding = result.embedding;
    } catch {
      console.warn('Failed to generate embedding for memory query');
    }

    let observationIds: string[] = [];

    if (queryEmbedding) {
      // Use hybrid search
      const { data: searchResults, error: searchError } = await this.supabase.rpc(
        'hybrid_search_memory',
        {
          query_embedding: queryEmbedding,
          query_text: queryText.slice(0, 500),
          repo_name: repoFullName,
          vector_weight: 0.7,
          match_count: limit,
        }
      );

      if (!searchError && searchResults) {
        observationIds = searchResults.map((r: { id: string }) => r.id);
      }
    }

    // Fetch full observations
    let observations: MemoryObservation[] = [];
    if (observationIds.length > 0) {
      let query = this.supabase
        .from('memory_observations')
        .select('id, session_id, installation_id, repo_full_name, observation_type, title, content_stripped, what_happened, why_it_matters, where_in_code, what_was_learned, tags, confidence, metadata, created_at')
        .in('id', observationIds);

      if (options?.observationType) {
        query = query.eq('observation_type', options.observationType);
      }

      const { data, error } = await query;
      if (!error && data) {
        observations = data as MemoryObservation[];
      }
    }

    // Count total sessions for this repo
    const { count } = await this.supabase
      .from('memory_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('repo_full_name', repoFullName)
      .eq('status', 'closed');

    return {
      observations,
      sessionCount: count || 0,
      query: queryText.slice(0, 200),
    };
  }

  /**
   * Format memory context as text for LLM prompt injection
   */
  formatContextForLLM(context: MemoryContext, maxTokens?: number): string {
    if (context.observations.length === 0) {
      return '';
    }

    const lines: string[] = [];
    lines.push('## Past Review Memory (learned from previous reviews)');
    lines.push('');

    for (const obs of context.observations) {
      let line = `- [${obs.observation_type}] ${obs.title}`;
      if (obs.where_in_code) {
        line += ` in ${obs.where_in_code}`;
      }
      lines.push(line);

      if (obs.what_was_learned) {
        lines.push(`  Learned: ${obs.what_was_learned}`);
      }
    }

    lines.push('');
    lines.push('Use these past observations to give more informed, context-aware reviews.');

    let result = lines.join('\n');

    // Truncate if needed (rough estimate: 4 chars per token)
    if (maxTokens && result.length > maxTokens * 4) {
      result = result.slice(0, maxTokens * 4) + '\n...(truncated)';
    }

    return result;
  }

  /**
   * Extract structured observations from review findings.
   * This is the key post-review method.
   */
  extractObservationsFromFindings(
    findings: ReviewFindingInput[],
    files: Array<{ filename: string }>,
    prNumber: number,
    sessionId: string,
    installationId: number,
    repoFullName: string
  ): AddObservationParams[] {
    const observations: AddObservationParams[] = [];

    // Group findings by file for consolidation
    const byFile = new Map<string, ReviewFindingInput[]>();
    for (const finding of findings) {
      const key = finding.file || '_global';
      const existing = byFile.get(key) || [];
      existing.push(finding);
      byFile.set(key, existing);
    }

    for (const [file, fileFindings] of byFile) {
      for (const finding of fileFindings) {
        const obsType = mapFindingToObservationType(finding);
        const tags = buildTags(finding);

        observations.push({
          sessionId,
          installationId,
          repoFullName,
          observationType: obsType,
          title: `${finding.category}: ${finding.message.slice(0, 100)}`,
          content: finding.message,
          whatHappened: finding.message,
          whyItMatters: finding.severity === 'error'
            ? 'Critical issue that could cause bugs or security problems'
            : finding.severity === 'warning'
            ? 'Potential issue that should be addressed'
            : 'Code quality observation',
          whereInCode: file !== '_global'
            ? `${file}${finding.line ? ':' + finding.line : ''}`
            : undefined,
          whatWasLearned: finding.suggestion || undefined,
          tags,
          confidence: mapSeverityToConfidence(finding.severity),
          metadata: { pr_number: prNumber, severity: finding.severity },
        });
      }
    }

    return observations;
  }

  /**
   * Get observation timeline for a session (for dashboard)
   */
  async getSessionTimeline(sessionId: string): Promise<MemoryObservation[]> {
    const { data, error } = await this.supabase
      .from('memory_observations')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) {
      throw new Error(`Failed to fetch session timeline: ${error.message}`);
    }

    return (data || []) as MemoryObservation[];
  }

  /**
   * Get memory stats for a repository
   */
  async getStats(repoFullName: string): Promise<MemoryStats> {
    const [sessionsResult, observationsResult] = await Promise.all([
      this.supabase
        .from('memory_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('repo_full_name', repoFullName),
      this.supabase
        .from('memory_observations')
        .select('observation_type')
        .eq('repo_full_name', repoFullName),
    ]);

    const totalSessions = sessionsResult.count || 0;
    const observations = observationsResult.data || [];
    const totalObservations = observations.length;

    const typeBreakdown: Record<ObservationType, number> = {
      decision: 0,
      architecture: 0,
      bugfix: 0,
      pattern: 0,
      config: 0,
      discovery: 0,
      learning: 0,
      session_summary: 0,
    };

    for (const obs of observations) {
      const type = obs.observation_type as ObservationType;
      if (type in typeBreakdown) {
        typeBreakdown[type]++;
      }
    }

    return { totalSessions, totalObservations, typeBreakdown };
  }
}

/** Map a review finding to an observation type */
function mapFindingToObservationType(
  finding: ReviewFindingInput
): ObservationType {
  if (finding.severity === 'error' && finding.category === 'security') {
    return 'bugfix';
  }
  if (finding.severity === 'error') {
    return 'bugfix';
  }
  if (finding.category === 'style' || finding.category === 'formatting') {
    return 'pattern';
  }
  if (finding.category === 'performance') {
    return 'discovery';
  }
  if (finding.category === 'architecture' || finding.category === 'design') {
    return 'architecture';
  }
  if (finding.category === 'config' || finding.category === 'configuration') {
    return 'config';
  }
  if (finding.severity === 'warning') {
    return 'learning';
  }
  return 'discovery';
}

/** Build tags from a finding */
function buildTags(finding: ReviewFindingInput): string[] {
  const tags: string[] = [finding.category, finding.severity];
  if (finding.file) {
    const ext = finding.file.split('.').pop();
    if (ext) tags.push(ext);
  }
  return tags;
}

/** Map severity to confidence score */
function mapSeverityToConfidence(
  severity: 'error' | 'warning' | 'info' | 'suggestion'
): number {
  switch (severity) {
    case 'error':
      return 0.9;
    case 'warning':
      return 0.7;
    case 'info':
      return 0.5;
    case 'suggestion':
      return 0.4;
    default:
      return 0.5;
  }
}
