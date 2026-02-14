-- Static Analysis configuration for repo_configs
-- Backwards compatible: all fields have sensible defaults

ALTER TABLE repo_configs
  ADD COLUMN IF NOT EXISTS static_analysis_enabled boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS ai_attribution_check boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS security_patterns_check boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS semgrep_service_url text DEFAULT '',
  ADD COLUMN IF NOT EXISTS commit_message_check boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS stack_aware_prompts boolean DEFAULT true;
