-- 003_reviews_embeddings.sql
-- Tables for code reviews and vector embeddings

-- Reviews table: stores AI code review data with embeddings
create table reviews (
  id uuid primary key default gen_random_uuid(),
  installation_id bigint references installations(id) on delete cascade,
  repo_full_name text not null,
  pr_number integer not null,
  file_path text not null,
  line_start integer,
  line_end integer,
  review_type text not null check (review_type in ('comment', 'suggestion', 'issue', 'praise')),
  content text not null,
  severity text check (severity in ('info', 'warning', 'error', 'critical')),
  embedding vector(1536),
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Review chunks table: stores chunked content for embedding
create table review_chunks (
  id uuid primary key default gen_random_uuid(),
  review_id uuid references reviews(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  embedding vector(1536),
  token_count integer,
  created_at timestamptz default now()
);

-- Indexes for reviews table
create index idx_reviews_repo on reviews(repo_full_name);
create index idx_reviews_pr on reviews(repo_full_name, pr_number);
create index idx_reviews_installation on reviews(installation_id);
create index idx_reviews_file on reviews(repo_full_name, file_path);

-- Indexes for review_chunks table
create index idx_review_chunks_review on review_chunks(review_id);

-- Apply updated_at trigger to reviews
create trigger reviews_updated_at
  before update on reviews
  for each row execute function update_updated_at_column();

-- Full-text search index on review content using pg_trgm
create index idx_reviews_content_trgm on reviews using gin (content gin_trgm_ops);
