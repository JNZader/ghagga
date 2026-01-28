/**
 * Hebbian learning types for adaptive weight adjustment
 * Based on "neurons that fire together, wire together" principle
 */

// Hebbian learning configuration
export interface HebbianConfig {
  enabled: boolean;
  learning_rate: number;
  decay_rate: number;
  min_weight: number;
  max_weight: number;
  update_frequency: 'immediate' | 'batch' | 'periodic';
}

// Hebbian connection between concepts
export interface HebbianConnection {
  id: string;
  repo_full_name: string;
  source_id: string;
  source_type: HebbianNodeType;
  target_id: string;
  target_type: HebbianNodeType;
  weight: number;
  activation_count: number;
  last_activated_at: string;
  created_at: string;
  updated_at: string;
}

// Types of nodes in Hebbian network
export type HebbianNodeType =
  | 'file_pattern'
  | 'error_type'
  | 'fix_pattern'
  | 'reviewer_preference'
  | 'code_pattern'
  | 'rule';

// Hebbian activation event
export interface HebbianActivation {
  source_id: string;
  source_type: HebbianNodeType;
  target_id: string;
  target_type: HebbianNodeType;
  strength: number;
  context?: HebbianContext;
}

// Context for Hebbian learning
export interface HebbianContext {
  repo_full_name: string;
  pr_number?: number;
  review_id?: string;
  outcome?: 'positive' | 'negative' | 'neutral';
}

// Hebbian weight update request
export interface HebbianUpdateRequest {
  activations: HebbianActivation[];
  learning_rate?: number;
  apply_decay?: boolean;
}

// Hebbian weight update result
export interface HebbianUpdateResult {
  updated_connections: number;
  created_connections: number;
  decayed_connections: number;
}

// Hebbian network state for a repository
export interface HebbianNetworkState {
  repo_full_name: string;
  total_connections: number;
  avg_weight: number;
  strongest_connections: HebbianConnection[];
  recently_activated: HebbianConnection[];
  last_updated_at: string;
}

// Query for finding related concepts
export interface HebbianRelationQuery {
  node_id: string;
  node_type: HebbianNodeType;
  repo_full_name?: string;
  min_weight?: number;
  limit?: number;
}

// Related concept result
export interface HebbianRelation {
  connection: HebbianConnection;
  direction: 'incoming' | 'outgoing';
}

// Batch activation for efficiency
export interface HebbianBatchActivation {
  repo_full_name: string;
  activations: HebbianActivation[];
  timestamp: string;
}

// Hebbian learning metrics
export interface HebbianMetrics {
  repo_full_name: string;
  total_activations: number;
  connections_created: number;
  connections_strengthened: number;
  connections_weakened: number;
  avg_learning_rate: number;
  period_start: string;
  period_end: string;
}

// Insert types
export type HebbianConnectionInsert = Omit<HebbianConnection, 'id' | 'created_at' | 'updated_at'>;
export type HebbianConnectionUpdate = Partial<Omit<HebbianConnection, 'id' | 'created_at'>>;
