-- 004_threads.sql
-- Tables for conversation threads and messages

-- Threads table: stores conversation threads for code review discussions
create table threads (
  id uuid primary key default gen_random_uuid(),
  installation_id bigint references installations(id) on delete cascade,
  repo_full_name text not null,
  pr_number integer not null,
  file_path text,
  line_number integer,
  status text not null default 'open' check (status in ('open', 'resolved', 'outdated')),
  context_summary text,
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Thread messages table: stores individual messages in a thread
create table thread_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid references threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  token_count integer,
  embedding vector(1536),
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

-- Thread context table: stores context snapshots for thread resumption
create table thread_contexts (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid references threads(id) on delete cascade,
  context_type text not null check (context_type in ('file', 'diff', 'review', 'summary')),
  content text not null,
  embedding vector(1536),
  relevance_score float,
  created_at timestamptz default now()
);

-- Indexes for threads table
create index idx_threads_repo_pr on threads(repo_full_name, pr_number);
create index idx_threads_installation on threads(installation_id);
create index idx_threads_status on threads(status) where status = 'open';

-- Indexes for thread_messages table
create index idx_thread_messages_thread on thread_messages(thread_id);
create index idx_thread_messages_created on thread_messages(thread_id, created_at);

-- Indexes for thread_contexts table
create index idx_thread_contexts_thread on thread_contexts(thread_id);

-- Apply updated_at trigger to threads
create trigger threads_updated_at
  before update on threads
  for each row execute function update_updated_at_column();
