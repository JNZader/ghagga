-- Add tsvector column for full-text search on memory observations.
-- This is a raw SQL migration because Drizzle doesn't support tsvector natively.

-- Add the search column
ALTER TABLE memory_observations
  ADD COLUMN IF NOT EXISTS search_observations tsvector;

-- Create GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS idx_observations_search
  ON memory_observations USING GIN (search_observations);

-- Populate existing rows (idempotent: only touches rows not yet backfilled,
-- avoiding a full table scan on every boot)
UPDATE memory_observations
SET search_observations = to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
WHERE search_observations IS NULL;

-- Create trigger function to auto-update tsvector on insert/update
CREATE OR REPLACE FUNCTION update_observations_search()
RETURNS trigger AS $$
BEGIN
  NEW.search_observations := to_tsvector('english', coalesce(NEW.title, '') || ' ' || coalesce(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach trigger
DROP TRIGGER IF EXISTS trg_observations_search ON memory_observations;
CREATE TRIGGER trg_observations_search
  BEFORE INSERT OR UPDATE OF title, content
  ON memory_observations
  FOR EACH ROW
  EXECUTE FUNCTION update_observations_search();
