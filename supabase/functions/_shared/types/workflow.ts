/**
 * Workflow and consensus types for multi-agent review orchestration
 */

// Workflow status
export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

// Workflow step status
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

// Workflow represents a multi-step review process
export interface Workflow {
  id: string;
  repo_full_name: string;
  pr_number: number;
  status: WorkflowStatus;
  current_step?: string;
  steps: WorkflowStep[];
  config: WorkflowConfig;
  result?: WorkflowResult;
  error?: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

// Configuration for workflow execution
export interface WorkflowConfig {
  timeout_ms?: number;
  max_retries?: number;
  parallel_steps?: boolean;
  fail_fast?: boolean;
  consensus_threshold?: number;
}

// Individual step in a workflow
export interface WorkflowStep {
  id: string;
  name: string;
  type: WorkflowStepType;
  status: StepStatus;
  config?: Record<string, unknown>;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  started_at?: string;
  completed_at?: string;
}

// Types of workflow steps
export type WorkflowStepType =
  | 'file_analysis'
  | 'security_scan'
  | 'style_check'
  | 'test_coverage'
  | 'dependency_check'
  | 'consensus'
  | 'summary'
  | 'custom';

// Workflow result summary
export interface WorkflowResult {
  passed: boolean;
  summary: string;
  score?: number;
  findings: WorkflowFinding[];
  metrics?: WorkflowMetrics;
}

// Individual finding from workflow
export interface WorkflowFinding {
  step: string;
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

// Workflow execution metrics
export interface WorkflowMetrics {
  total_duration_ms: number;
  step_durations: Record<string, number>;
  tokens_used: number;
  files_analyzed: number;
}

// Consensus types for multi-model agreement

// Consensus configuration
export interface ConsensusConfig {
  models: ConsensusModel[];
  threshold: number;
  voting_strategy: 'majority' | 'unanimous' | 'weighted';
  timeout_ms?: number;
}

// Model participating in consensus
export interface ConsensusModel {
  provider: string;
  model: string;
  weight?: number;
}

// Consensus result
export interface ConsensusResult {
  id: string;
  workflow_id?: string;
  agreed: boolean;
  agreement_score: number;
  votes: ConsensusVote[];
  final_decision: string;
  reasoning?: string;
  created_at: string;
}

// Individual vote in consensus
export interface ConsensusVote {
  model: string;
  provider: string;
  decision: 'approve' | 'reject' | 'abstain';
  confidence: number;
  reasoning: string;
  response_time_ms: number;
}

// Insert types
export type WorkflowInsert = Omit<Workflow, 'id' | 'created_at' | 'updated_at'>;
export type ConsensusResultInsert = Omit<ConsensusResult, 'id' | 'created_at'>;
