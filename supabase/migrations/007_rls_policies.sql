-- 007_rls_policies.sql
-- Row Level Security policies for all tables

-- Enable RLS on all tables
alter table installations enable row level security;
alter table repo_configs enable row level security;
alter table reviews enable row level security;
alter table review_chunks enable row level security;
alter table threads enable row level security;
alter table thread_messages enable row level security;
alter table thread_contexts enable row level security;
alter table hebbian_associations enable row level security;
alter table hebbian_patterns enable row level security;
alter table hebbian_feedback enable row level security;

-- Service role policies (full access for backend services)
-- Installations
create policy "Service role full access to installations"
  on installations for all
  using (auth.role() = 'service_role');

-- Repo configs
create policy "Service role full access to repo_configs"
  on repo_configs for all
  using (auth.role() = 'service_role');

-- Reviews
create policy "Service role full access to reviews"
  on reviews for all
  using (auth.role() = 'service_role');

-- Review chunks
create policy "Service role full access to review_chunks"
  on review_chunks for all
  using (auth.role() = 'service_role');

-- Threads
create policy "Service role full access to threads"
  on threads for all
  using (auth.role() = 'service_role');

-- Thread messages
create policy "Service role full access to thread_messages"
  on thread_messages for all
  using (auth.role() = 'service_role');

-- Thread contexts
create policy "Service role full access to thread_contexts"
  on thread_contexts for all
  using (auth.role() = 'service_role');

-- Hebbian associations
create policy "Service role full access to hebbian_associations"
  on hebbian_associations for all
  using (auth.role() = 'service_role');

-- Hebbian patterns
create policy "Service role full access to hebbian_patterns"
  on hebbian_patterns for all
  using (auth.role() = 'service_role');

-- Hebbian feedback
create policy "Service role full access to hebbian_feedback"
  on hebbian_feedback for all
  using (auth.role() = 'service_role');

-- Anon role policies (read-only access for public endpoints if needed)
-- These are restrictive by default - only allow if explicitly needed

-- Public read access to reviews for API consumers (optional, uncomment if needed)
-- create policy "Anon read access to reviews"
--   on reviews for select
--   using (auth.role() = 'anon');

-- Authenticated user policies (for future web dashboard)
-- Users can only see data from their own installations

-- Authenticated users can read their installations
create policy "Users can read own installations"
  on installations for select
  using (
    auth.role() = 'authenticated' 
    and id in (
      select installation_id from repo_configs 
      where repo_full_name in (
        select repo_full_name from repo_configs 
        where installation_id = installations.id
      )
    )
  );

-- Authenticated users can read repo configs for their repos
create policy "Users can read own repo_configs"
  on repo_configs for select
  using (
    auth.role() = 'authenticated'
    and installation_id in (
      select id from installations
    )
  );

-- Authenticated users can read reviews for their repos
create policy "Users can read own reviews"
  on reviews for select
  using (
    auth.role() = 'authenticated'
    and installation_id in (
      select id from installations
    )
  );

-- Authenticated users can read threads for their repos
create policy "Users can read own threads"
  on threads for select
  using (
    auth.role() = 'authenticated'
    and installation_id in (
      select id from installations
    )
  );

-- Grant execute permissions on functions
grant execute on function search_reviews_vector to service_role;
grant execute on function search_thread_messages_vector to service_role;
grant execute on function search_hebbian_patterns_vector to service_role;
grant execute on function hybrid_search_reviews to service_role;
grant execute on function update_hebbian_weight to service_role;
grant execute on function get_thread_context to service_role;
grant execute on function update_updated_at_column to service_role;
