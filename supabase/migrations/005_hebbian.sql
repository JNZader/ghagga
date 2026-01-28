-- 005_hebbian.sql
-- Tables for Hebbian learning and pattern associations

-- Hebbian associations table: stores learned associations between patterns
create table hebbian_associations (
  id uuid primary key default gen_random_uuid(),
  installation_id bigint references installations(id) on delete cascade,
  repo_full_name text not null,
  source_pattern text not null,
  target_pattern text not null,
  association_type text not null check (association_type in ('code_pattern', 'review_pattern', 'error_fix', 'style_preference')),
  weight float not null default 0.5 check (weight >= 0 and weight <= 1),
  activation_count integer not null default 1,
  last_activated_at timestamptz default now(),
  source_embedding vector(1536),
  target_embedding vector(1536),
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Hebbian patterns table: stores individual patterns for learning
create table hebbian_patterns (
  id uuid primary key default gen_random_uuid(),
  installation_id bigint references installations(id) on delete cascade,
  repo_full_name text not null,
  pattern_type text not null check (pattern_type in ('code', 'review', 'error', 'style')),
  pattern_content text not null,
  pattern_hash text not null,
  embedding vector(1536),
  frequency integer not null default 1,
  confidence float default 0.5 check (confidence >= 0 and confidence <= 1),
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Hebbian feedback table: stores user feedback for reinforcement learning
create table hebbian_feedback (
  id uuid primary key default gen_random_uuid(),
  association_id uuid references hebbian_associations(id) on delete cascade,
  pattern_id uuid references hebbian_patterns(id) on delete set null,
  feedback_type text not null check (feedback_type in ('positive', 'negative', 'neutral')),
  feedback_source text not null check (feedback_source in ('explicit', 'implicit', 'inferred')),
  feedback_value float not null check (feedback_value >= -1 and feedback_value <= 1),
  context jsonb default '{}',
  created_at timestamptz default now()
);

-- Indexes for hebbian_associations
create index idx_hebbian_assoc_repo on hebbian_associations(repo_full_name);
create index idx_hebbian_assoc_installation on hebbian_associations(installation_id);
create index idx_hebbian_assoc_type on hebbian_associations(association_type);
create index idx_hebbian_assoc_weight on hebbian_associations(weight desc) where weight > 0.7;

-- Indexes for hebbian_patterns
create index idx_hebbian_patterns_repo on hebbian_patterns(repo_full_name);
create index idx_hebbian_patterns_hash on hebbian_patterns(pattern_hash);
create index idx_hebbian_patterns_type on hebbian_patterns(pattern_type);

-- Indexes for hebbian_feedback
create index idx_hebbian_feedback_assoc on hebbian_feedback(association_id);
create index idx_hebbian_feedback_pattern on hebbian_feedback(pattern_id);

-- Unique constraint for pattern deduplication
create unique index idx_hebbian_patterns_unique on hebbian_patterns(repo_full_name, pattern_hash);

-- Apply updated_at triggers
create trigger hebbian_associations_updated_at
  before update on hebbian_associations
  for each row execute function update_updated_at_column();

create trigger hebbian_patterns_updated_at
  before update on hebbian_patterns
  for each row execute function update_updated_at_column();
