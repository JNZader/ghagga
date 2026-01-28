/**
 * Hebbian Learning implementation
 * "Neurons that fire together, wire together"
 *
 * This module implements adaptive learning for code review patterns,
 * strengthening associations between concepts that appear together.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import type {
  HebbianConfig,
  HebbianConnection,
} from '../types/hebbian.ts';

/**
 * Association type for Hebbian learning
 */
export type AssociationType =
  | 'code_pattern'
  | 'review_pattern'
  | 'error_fix'
  | 'style_preference';

/**
 * Prediction result from Hebbian associations
 */
export interface PredictionResult {
  concept: string;
  weight: number;
  associationType: AssociationType;
  activationCount: number;
}

/**
 * Options for strengthening associations
 */
export interface StrengthenOptions {
  learningRate?: number;
  associationType?: AssociationType;
}

/**
 * Options for predictions
 */
export interface PredictOptions {
  minWeight?: number;
  limit?: number;
  associationTypes?: AssociationType[];
}

/**
 * Options for decay
 */
export interface DecayOptions {
  decayRate?: number;
  minWeight?: number;
}

/**
 * Default Hebbian configuration
 */
const DEFAULT_CONFIG: HebbianConfig = {
  enabled: true,
  learning_rate: 0.1,
  decay_rate: 0.01,
  min_weight: 0.0,
  max_weight: 1.0,
  update_frequency: 'immediate',
};

/**
 * HebbianLearner class for adaptive learning
 * Manages associations between concepts based on co-occurrence
 */
export class HebbianLearner {
  private supabase: SupabaseClient;
  private config: HebbianConfig;

  constructor(supabase: SupabaseClient, config?: Partial<HebbianConfig>) {
    this.supabase = supabase;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Strengthen the association between two concepts
   * Uses Hebbian learning rule: weights increase when concepts co-occur
   *
   * @param repoFullName - Repository identifier
   * @param conceptA - First concept (source pattern)
   * @param conceptB - Second concept (target pattern)
   * @param options - Optional learning parameters
   */
  async strengthen(
    repoFullName: string,
    conceptA: string,
    conceptB: string,
    options: StrengthenOptions = {}
  ): Promise<void> {
    const learningRate = options.learningRate ?? this.config.learning_rate;
    const associationType = options.associationType ?? 'code_pattern';

    // Ensure consistent ordering for bidirectional associations
    const [source, target] =
      conceptA < conceptB ? [conceptA, conceptB] : [conceptB, conceptA];

    // Check if association exists
    const { data: existing } = await this.supabase
      .from('hebbian_associations')
      .select('id, weight, activation_count')
      .eq('repo_full_name', repoFullName)
      .eq('source_pattern', source)
      .eq('target_pattern', target)
      .eq('association_type', associationType)
      .single();

    if (existing) {
      // Update existing association using Hebbian rule
      const currentWeight = existing.weight;
      const reinforcement = 1.0; // Positive reinforcement for co-occurrence

      // Hebbian update: w_new = w_old + lr * (reinforcement - w_old)
      const newWeight = Math.min(
        this.config.max_weight,
        currentWeight + learningRate * (reinforcement - currentWeight)
      );

      await this.supabase
        .from('hebbian_associations')
        .update({
          weight: newWeight,
          activation_count: existing.activation_count + 1,
          last_activated_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
    } else {
      // Create new association with initial weight
      const initialWeight = 0.5 + learningRate * 0.5;

      await this.supabase.from('hebbian_associations').insert({
        repo_full_name: repoFullName,
        source_pattern: source,
        target_pattern: target,
        association_type: associationType,
        weight: Math.min(this.config.max_weight, initialWeight),
        activation_count: 1,
        last_activated_at: new Date().toISOString(),
      });
    }
  }

  /**
   * Strengthen multiple concept pairs at once
   *
   * @param repoFullName - Repository identifier
   * @param concepts - Array of concepts that co-occurred
   * @param options - Optional learning parameters
   */
  async strengthenAll(
    repoFullName: string,
    concepts: string[],
    options: StrengthenOptions = {}
  ): Promise<void> {
    // Create all pairwise associations
    for (let i = 0; i < concepts.length; i++) {
      for (let j = i + 1; j < concepts.length; j++) {
        await this.strengthen(
          repoFullName,
          concepts[i],
          concepts[j],
          options
        );
      }
    }
  }

  /**
   * Predict related concepts based on learned associations
   *
   * @param repoFullName - Repository identifier
   * @param concepts - Input concepts to find associations for
   * @param options - Prediction options
   * @returns Array of predicted concepts with weights
   */
  async predict(
    repoFullName: string,
    concepts: string[],
    options: PredictOptions = {}
  ): Promise<PredictionResult[]> {
    const minWeight = options.minWeight ?? 0.3;
    const limit = options.limit ?? 10;

    if (concepts.length === 0) {
      return [];
    }

    // Build query for associations where input concepts are source or target
    const conceptFilters = concepts
      .map((c) => `source_pattern.eq.${c},target_pattern.eq.${c}`)
      .join(',');

    let query = this.supabase
      .from('hebbian_associations')
      .select('source_pattern, target_pattern, weight, association_type, activation_count')
      .eq('repo_full_name', repoFullName)
      .or(conceptFilters)
      .gte('weight', minWeight)
      .order('weight', { ascending: false })
      .limit(limit * 2); // Get extra to filter out input concepts

    if (options.associationTypes && options.associationTypes.length > 0) {
      query = query.in('association_type', options.associationTypes);
    }

    const { data, error } = await query;

    if (error || !data) {
      return [];
    }

    // Extract related concepts (not in input)
    const inputSet = new Set(concepts);
    const resultMap = new Map<string, PredictionResult>();

    for (const row of data) {
      // Get the concept that's not in the input
      const relatedConcept = inputSet.has(row.source_pattern)
        ? row.target_pattern
        : row.source_pattern;

      // Skip if it's also in the input
      if (inputSet.has(relatedConcept)) {
        continue;
      }

      // Aggregate weights for concepts with multiple associations
      const existing = resultMap.get(relatedConcept);
      if (existing) {
        existing.weight = Math.max(existing.weight, row.weight);
        existing.activationCount += row.activation_count;
      } else {
        resultMap.set(relatedConcept, {
          concept: relatedConcept,
          weight: row.weight,
          associationType: row.association_type as AssociationType,
          activationCount: row.activation_count,
        });
      }
    }

    // Sort by weight and limit
    return Array.from(resultMap.values())
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);
  }

  /**
   * Apply decay to all associations in a repository
   * Reduces weights over time for less frequently used associations
   *
   * @param repoFullName - Repository identifier
   * @param options - Decay options
   * @returns Number of associations decayed
   */
  async decay(
    repoFullName: string,
    options: DecayOptions = {}
  ): Promise<number> {
    const decayRate = options.decayRate ?? this.config.decay_rate;
    const minWeight = options.minWeight ?? this.config.min_weight;

    // Get all associations for the repository
    const { data: associations, error } = await this.supabase
      .from('hebbian_associations')
      .select('id, weight, last_activated_at')
      .eq('repo_full_name', repoFullName)
      .gt('weight', minWeight);

    if (error || !associations) {
      return 0;
    }

    const now = new Date();
    let decayedCount = 0;

    for (const assoc of associations) {
      const lastActivated = new Date(assoc.last_activated_at);
      const hoursSinceActivation =
        (now.getTime() - lastActivated.getTime()) / (1000 * 60 * 60);

      // Exponential decay based on time since last activation
      const timeDecay = Math.exp(-decayRate * hoursSinceActivation);
      const newWeight = Math.max(minWeight, assoc.weight * timeDecay);

      // Only update if weight changed significantly
      if (Math.abs(newWeight - assoc.weight) > 0.001) {
        await this.supabase
          .from('hebbian_associations')
          .update({ weight: newWeight })
          .eq('id', assoc.id);
        decayedCount++;
      }
    }

    return decayedCount;
  }

  /**
   * Get the current configuration
   */
  getConfig(): HebbianConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<HebbianConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get network statistics for a repository
   */
  async getNetworkStats(repoFullName: string): Promise<{
    totalConnections: number;
    avgWeight: number;
    strongConnections: number;
  }> {
    const { data, error } = await this.supabase
      .from('hebbian_associations')
      .select('weight')
      .eq('repo_full_name', repoFullName);

    if (error || !data || data.length === 0) {
      return {
        totalConnections: 0,
        avgWeight: 0,
        strongConnections: 0,
      };
    }

    const weights = data.map((d) => d.weight);
    const avgWeight = weights.reduce((a, b) => a + b, 0) / weights.length;
    const strongConnections = weights.filter((w) => w > 0.7).length;

    return {
      totalConnections: data.length,
      avgWeight,
      strongConnections,
    };
  }
}
