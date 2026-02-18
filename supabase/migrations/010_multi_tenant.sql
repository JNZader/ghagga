-- 010_multi_tenant.sql
-- Multi-tenant support: per-repo API keys, user-installation mappings, proper RLS

-- =============================================================================
-- 1. Add encrypted API key columns to repo_configs
-- =============================================================================
ALTER TABLE repo_configs
  ADD COLUMN IF NOT EXISTS anthropic_api_key_encrypted text,
  ADD COLUMN IF NOT EXISTS openai_api_key_encrypted text,
  ADD COLUMN IF NOT EXISTS google_ai_api_key_encrypted text,
  ADD COLUMN IF NOT EXISTS api_keys_configured jsonb NOT NULL DEFAULT '{}';

-- =============================================================================
-- 2. Create github_user_mappings table
-- =============================================================================
CREATE TABLE IF NOT EXISTS github_user_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supabase_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  github_user_id bigint NOT NULL,
  github_username text NOT NULL,
  installation_id bigint REFERENCES installations(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (supabase_user_id, installation_id)
);

CREATE INDEX IF NOT EXISTS idx_github_user_mappings_supabase_user
  ON github_user_mappings (supabase_user_id);

CREATE INDEX IF NOT EXISTS idx_github_user_mappings_installation
  ON github_user_mappings (installation_id);

-- Auto-update updated_at
CREATE TRIGGER trg_github_user_mappings_updated_at
  BEFORE UPDATE ON github_user_mappings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 3. Helper function: get installation IDs for current user
-- =============================================================================
CREATE OR REPLACE FUNCTION get_user_installation_ids()
RETURNS SETOF bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT installation_id
  FROM github_user_mappings
  WHERE supabase_user_id = auth.uid()
    AND installation_id IS NOT NULL;
$$;

GRANT EXECUTE ON FUNCTION get_user_installation_ids TO authenticated;

-- =============================================================================
-- 4. Replace tautological RLS policies with proper tenant-scoped ones
-- =============================================================================

-- Drop old authenticated policies from 007
DROP POLICY IF EXISTS "Users can read own installations" ON installations;
DROP POLICY IF EXISTS "Users can read own repo_configs" ON repo_configs;
DROP POLICY IF EXISTS "Users can read own reviews" ON reviews;
DROP POLICY IF EXISTS "Users can read own threads" ON threads;

-- Drop old authenticated policies from 009
DROP POLICY IF EXISTS "Users can read own memory_sessions" ON memory_sessions;
DROP POLICY IF EXISTS "Users can read own memory_observations" ON memory_observations;

-- Installations: users can only see their own
CREATE POLICY "Users can read own installations"
  ON installations FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND id IN (SELECT get_user_installation_ids())
  );

-- Repo configs: users can only see repos from their installations
CREATE POLICY "Users can read own repo_configs"
  ON repo_configs FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND installation_id IN (SELECT get_user_installation_ids())
  );

-- Repo configs: users can update non-key fields on their repos
CREATE POLICY "Users can update own repo_configs"
  ON repo_configs FOR UPDATE
  USING (
    auth.role() = 'authenticated'
    AND installation_id IN (SELECT get_user_installation_ids())
  )
  WITH CHECK (
    auth.role() = 'authenticated'
    AND installation_id IN (SELECT get_user_installation_ids())
  );

-- Reviews: users can only see reviews from their installations
CREATE POLICY "Users can read own reviews"
  ON reviews FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND installation_id IN (SELECT get_user_installation_ids())
  );

-- Threads: users can only see threads from their installations
CREATE POLICY "Users can read own threads"
  ON threads FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND installation_id IN (SELECT get_user_installation_ids())
  );

-- Memory sessions: users can only see sessions from their installations
CREATE POLICY "Users can read own memory_sessions"
  ON memory_sessions FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND installation_id IN (SELECT get_user_installation_ids())
  );

-- Memory observations: users can only see observations from their installations
CREATE POLICY "Users can read own memory_observations"
  ON memory_observations FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND installation_id IN (SELECT get_user_installation_ids())
  );

-- =============================================================================
-- 5. RLS for github_user_mappings
-- =============================================================================
ALTER TABLE github_user_mappings ENABLE ROW LEVEL SECURITY;

-- Service role: full access
CREATE POLICY "Service role full access to github_user_mappings"
  ON github_user_mappings FOR ALL
  USING (auth.role() = 'service_role');

-- Authenticated users: read only their own mappings
CREATE POLICY "Users can read own github_user_mappings"
  ON github_user_mappings FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND supabase_user_id = auth.uid()
  );

-- =============================================================================
-- 6. Trigger to prevent direct API key updates from non-service roles
-- =============================================================================
CREATE OR REPLACE FUNCTION prevent_direct_api_key_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Allow service_role to update anything
  IF current_setting('role', true) = 'service_role'
     OR current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Block direct updates to encrypted key columns from authenticated users
  IF OLD.anthropic_api_key_encrypted IS DISTINCT FROM NEW.anthropic_api_key_encrypted
     OR OLD.openai_api_key_encrypted IS DISTINCT FROM NEW.openai_api_key_encrypted
     OR OLD.google_ai_api_key_encrypted IS DISTINCT FROM NEW.google_ai_api_key_encrypted THEN
    RAISE EXCEPTION 'Direct API key updates are not allowed. Use the manage-api-keys endpoint.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_prevent_direct_api_key_update
  BEFORE UPDATE ON repo_configs
  FOR EACH ROW EXECUTE FUNCTION prevent_direct_api_key_update();

-- Grant execute on helper function
GRANT EXECUTE ON FUNCTION prevent_direct_api_key_update TO authenticated;
GRANT EXECUTE ON FUNCTION prevent_direct_api_key_update TO service_role;
