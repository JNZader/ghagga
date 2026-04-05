-- Add embedding column for hybrid search (feature #4: ghagga-intelligence-v2).
-- Stored as REAL[] (PostgreSQL double-precision array).
-- NULL when no embedding provider was available at insertion time.
-- Hybrid search uses: final_score = 0.7 * cosine_similarity + 0.3 * ts_rank

ALTER TABLE memory_observations
  ADD COLUMN IF NOT EXISTS embedding DOUBLE PRECISION[];
