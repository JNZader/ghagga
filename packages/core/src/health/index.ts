export {
  aggregateHealth,
  type DigestInputs,
  type DigestReviewGroup,
  type FileRisk,
  MAX_RANKED_FILES,
  RANKING_WINDOW_DAYS,
  RECENCY_FULL_DAYS,
  type ReviewRow,
  rankFileRisk,
} from './digest.js';
export {
  generateRecommendations,
  type HealthRecommendation,
} from './recommendations.js';
export {
  computeHealthScore,
  formatTopIssues,
  getScoreColor,
  type HealthScore,
  SEVERITY_WEIGHTS,
} from './score.js';
export {
  computeTrend,
  type HealthHistoryEntry,
  type HealthTrend,
  loadHistory,
  saveHistory,
} from './trends.js';
