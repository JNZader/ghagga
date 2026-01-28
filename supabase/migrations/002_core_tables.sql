-- 002_core_tables.sql
-- Core tables for GitHub App installations and repository configurations

-- Installations table: tracks GitHub App installations
create table installations (
  id bigint primary key,
  account_login text not null,
  account_type text not null check (account_type in ('User', 'Organization')),
  account_avatar_url text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Repository configurations table: per-repo settings
create table repo_configs (
  id uuid primary key default gen_random_uuid(),
  installation_id bigint references installations(id) on delete cascade,
  repo_full_name text unique not null,
  enabled boolean default true,
  provider text default 'claude',
  model text default 'claude-sonnet-4-20250514',
  rules text,
  file_patterns text[] default array['*.ts', '*.tsx', '*.js', '*.py'],
  exclude_patterns text[] default array['*.test.*', 'node_modules/*'],
  workflow_enabled boolean default false,
  consensus_enabled boolean default false,
  hebbian_enabled boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Index for faster lookups by installation
create index idx_repo_configs_installation_id on repo_configs(installation_id);

-- Trigger function to update updated_at timestamp
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Apply updated_at trigger to installations
create trigger installations_updated_at
  before update on installations
  for each row execute function update_updated_at_column();

-- Apply updated_at trigger to repo_configs
create trigger repo_configs_updated_at
  before update on repo_configs
  for each row execute function update_updated_at_column();
