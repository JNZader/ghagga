-- 009_engram_memory.sql
-- Engram-style persistent memory for code reviews
-- Sessions (1 PR = 1 session) and structured observations

-- Memory sessions (one per PR review)
create table memory_sessions (
  id uuid primary key default gen_random_uuid(),
  installation_id bigint references installations(id) on delete cascade,
  repo_full_name text not null,
  pr_number int not null,
  session_name text not null,
  status text not null default 'active' check (status in ('active', 'closed', 'archived')),
  summary text,
  summary_embedding vector(1536),
  metadata jsonb default '{}',
  started_at timestamptz default now(),
  closed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Memory observations (structured findings from reviews)
create table memory_observations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references memory_sessions(id) on delete cascade,
  installation_id bigint references installations(id) on delete cascade,
  repo_full_name text not null,
  observation_type text not null check (observation_type in (
    'decision', 'architecture', 'bugfix', 'pattern',
    'config', 'discovery', 'learning', 'session_summary'
  )),
  title text not null,
  content text not null,
  content_stripped text,
  what_happened text,
  why_it_matters text,
  where_in_code text,
  what_was_learned text,
  tags text[] default '{}',
  embedding vector(1536),
  search_vector tsvector,
  confidence float default 0.5 check (confidence >= 0 and confidence <= 1),
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Trigger: auto-generate search_vector with weighted fields
create or replace function memory_observations_search_vector_trigger()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    setweight(to_tsvector('english', coalesce(new.what_happened, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.what_was_learned, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(new.content_stripped, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(array_to_string(new.tags, ' '), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(new.where_in_code, '')), 'C');
  return new;
end;
$$;

create trigger trg_memory_observations_search_vector
  before insert or update on memory_observations
  for each row execute function memory_observations_search_vector_trigger();

-- Trigger: auto-update updated_at
create trigger trg_memory_sessions_updated_at
  before update on memory_sessions
  for each row execute function update_updated_at_column();

create trigger trg_memory_observations_updated_at
  before update on memory_observations
  for each row execute function update_updated_at_column();

-- Indexes: HNSW for vector search
create index idx_memory_observations_embedding
  on memory_observations using hnsw (embedding vector_cosine_ops);

create index idx_memory_sessions_summary_embedding
  on memory_sessions using hnsw (summary_embedding vector_cosine_ops);

-- Indexes: GIN for full-text search and tags
create index idx_memory_observations_search_vector
  on memory_observations using gin (search_vector);

create index idx_memory_observations_tags
  on memory_observations using gin (tags);

-- Indexes: btree for common queries
create index idx_memory_sessions_repo
  on memory_sessions (repo_full_name);

create index idx_memory_sessions_repo_pr
  on memory_sessions (repo_full_name, pr_number);

create index idx_memory_observations_repo
  on memory_observations (repo_full_name);

create index idx_memory_observations_session
  on memory_observations (session_id);

create index idx_memory_observations_type
  on memory_observations (observation_type);

create index idx_memory_observations_repo_type
  on memory_observations (repo_full_name, observation_type);

-- Trigram index for fuzzy text search on content_stripped
create index idx_memory_observations_content_trgm
  on memory_observations using gin (content_stripped gin_trgm_ops);

-- RPC: Vector-only search for memory observations
create or replace function search_memory_observations_vector(
  query_embedding vector(1536),
  repo_name text,
  target_observation_type text default null,
  match_threshold float default 0.5,
  match_count int default 10
)
returns table (id uuid, similarity float, observation_type text, confidence float)
language sql stable
as $$
  select
    id,
    1 - (embedding <=> query_embedding) as similarity,
    observation_type,
    confidence
  from memory_observations
  where repo_full_name = repo_name
    and embedding is not null
    and (target_observation_type is null or observation_type = target_observation_type)
    and 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- RPC: Hybrid search combining vector similarity + FTS
create or replace function hybrid_search_memory(
  query_embedding vector(1536),
  query_text text,
  repo_name text,
  vector_weight float default 0.7,
  match_count int default 10
)
returns table (id uuid, combined_score float, vector_score float, text_score float)
language sql stable
as $$
  with vector_matches as (
    select id, 1 - (embedding <=> query_embedding) as score
    from memory_observations
    where repo_full_name = repo_name
      and embedding is not null
    order by embedding <=> query_embedding
    limit match_count * 2
  ),
  text_matches as (
    select id, ts_rank_cd(search_vector, websearch_to_tsquery('english', query_text)) as score
    from memory_observations
    where repo_full_name = repo_name
      and search_vector @@ websearch_to_tsquery('english', query_text)
    order by score desc
    limit match_count * 2
  )
  select
    coalesce(v.id, t.id) as id,
    (coalesce(v.score, 0) * vector_weight + coalesce(t.score, 0) * (1 - vector_weight)) as combined_score,
    coalesce(v.score, 0) as vector_score,
    coalesce(t.score, 0) as text_score
  from vector_matches v
  full outer join text_matches t on v.id = t.id
  order by combined_score desc
  limit match_count;
$$;

-- RLS: Enable row level security
alter table memory_sessions enable row level security;
alter table memory_observations enable row level security;

-- RLS: Service role full access
create policy "Service role full access to memory_sessions"
  on memory_sessions for all
  using (auth.role() = 'service_role');

create policy "Service role full access to memory_observations"
  on memory_observations for all
  using (auth.role() = 'service_role');

-- RLS: Authenticated users read-only scoped by installation_id
create policy "Users can read own memory_sessions"
  on memory_sessions for select
  using (
    auth.role() = 'authenticated'
    and installation_id in (
      select id from installations
    )
  );

create policy "Users can read own memory_observations"
  on memory_observations for select
  using (
    auth.role() = 'authenticated'
    and installation_id in (
      select id from installations
    )
  );

-- Grant execute on new functions
grant execute on function search_memory_observations_vector to service_role;
grant execute on function hybrid_search_memory to service_role;
grant execute on function memory_observations_search_vector_trigger to service_role;

-- Add memory_enabled to repo_configs
alter table repo_configs add column if not exists memory_enabled boolean default false;
