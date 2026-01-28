/**
 * Consensus Engine Module
 *
 * Multi-model consensus building for code review decisions.
 * Supports different stances (for/against/neutral) and weighted voting.
 */

export {
  // Types
  type Stance,
  type ConsensusModelConfig,
  type ConsensusResponse,
  type ConsensusEngineResult,
  type ConsensusEngineConfig,
  type AIProvider,
  // Constants
  STANCE_PROMPTS,
  // Class
  ConsensusEngine,
} from './engine.ts';
