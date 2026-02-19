-- 011_security_definer_search_path.sql
-- Fix SECURITY DEFINER functions to set search_path, preventing search_path hijacking

-- Fix get_user_installation_ids: add SET search_path
CREATE OR REPLACE FUNCTION get_user_installation_ids()
RETURNS SETOF bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT installation_id
  FROM github_user_mappings
  WHERE supabase_user_id = auth.uid()
    AND installation_id IS NOT NULL;
$$;

-- Fix prevent_direct_api_key_update: use auth.role() instead of spoofable current_setting
CREATE OR REPLACE FUNCTION prevent_direct_api_key_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Allow service_role to update anything (use auth.role() for consistency with RLS)
  IF auth.role() = 'service_role' THEN
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

-- Remove unnecessary EXECUTE grant on trigger function to authenticated role
REVOKE EXECUTE ON FUNCTION prevent_direct_api_key_update FROM authenticated;
