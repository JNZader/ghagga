-- Add last_accessed_at column for memory decay tracking.
-- Observations not re-accessed lose strength over time.

ALTER TABLE memory_observations
  ADD COLUMN last_accessed_at TIMESTAMP NOT NULL DEFAULT now();

-- Backfill: set last_accessed_at = updated_at for existing rows
UPDATE memory_observations SET last_accessed_at = updated_at;

-- Index for efficient filtering by access recency
CREATE INDEX idx_observations_last_accessed_at
  ON memory_observations (last_accessed_at);
