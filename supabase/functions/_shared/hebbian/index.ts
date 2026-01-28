/**
 * Hebbian Learning Module
 *
 * Implements adaptive learning for code review patterns based on
 * the Hebbian principle: "neurons that fire together, wire together"
 *
 * @module hebbian
 */

// Concept extraction utilities
export {
  extractConcepts,
  extractConceptsWithScores,
  extractConceptsFromMultiple,
  getAvailableConcepts,
  type ConceptExtractionResult,
} from './concepts.ts';

// Hebbian learner class and types
export {
  HebbianLearner,
  type AssociationType,
  type PredictionResult,
  type StrengthenOptions,
  type PredictOptions,
  type DecayOptions,
} from './learner.ts';
