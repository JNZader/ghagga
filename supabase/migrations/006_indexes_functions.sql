-- 006_indexes_functions.sql
-- Vector similarity indexes and RPC functions

-- Vector similarity indexes using HNSW for fast approximate nearest neighbor search
create index idx_reviews_embedding on reviews using hnsw (embedding vector_cosine_ops);
create index idx_review_chunks_embedding on review_chunks using hnsw (embedding vector_cosine_ops);
create index idx_thread_messages_embedding on thread_messages using hnsw (embedding vector_cosine_ops);
create index idx_thread_contexts_embedding on thread_contexts using hnsw (embedding vector_cosine_ops);
create index idx_hebbian_assoc_source_embedding on hebbian_associations using hnsw (source_embedding vector_cosine_ops);
create index idx_hebbian_assoc_target_embedding on hebbian_associations using hnsw (target_embedding vector_cosine_ops);
create index idx_hebbian_patterns_embedding on hebbian_patterns using hnsw (embedding vector_cosine_ops);

-- Function: Search reviews by vector similarity
create or replace function search_reviews_vector(
  query_embedding vector(1536),
  repo_name text,
  match_threshold float default 0.5,
  match_count int default 10
)
returns table (id uuid, similarity float)
language sql stable
as $$
  select id, 1 - (embedding <=> query_embedding) as similarity
  from reviews
  where repo_full_name = repo_name
    and embedding is not null
    and 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- Function: Search thread messages by vector similarity
create or replace function search_thread_messages_vector(
  query_embedding vector(1536),
  target_thread_id uuid,
  match_threshold float default 0.5,
  match_count int default 20
)
returns table (id uuid, similarity float)
language sql stable
as $$
  select id, 1 - (embedding <=> query_embedding) as similarity
  from thread_messages
  where thread_id = target_thread_id
    and embedding is not null
    and 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- Function: Search hebbian patterns by vector similarity
create or replace function search_hebbian_patterns_vector(
  query_embedding vector(1536),
  repo_name text,
  target_pattern_type text default null,
  match_threshold float default 0.5,
  match_count int default 10
)
returns table (id uuid, similarity float, pattern_type text, confidence float)
language sql stable
as $$
  select 
    id, 
    1 - (embedding <=> query_embedding) as similarity,
    pattern_type,
    confidence
  from hebbian_patterns
  where repo_full_name = repo_name
    and embedding is not null
    and (target_pattern_type is null or pattern_type = target_pattern_type)
    and 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- Function: Hybrid search combining vector similarity and FTS
create or replace function hybrid_search_reviews(
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
    from reviews
    where repo_full_name = repo_name
      and embedding is not null
    order by embedding <=> query_embedding
    limit match_count * 2
  ),
  text_matches as (
    select id, similarity(content, query_text) as score
    from reviews
    where repo_full_name = repo_name
      and content % query_text
    order by similarity(content, query_text) desc
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

-- Function: Update Hebbian association weight with decay
create or replace function update_hebbian_weight(
  assoc_id uuid,
  reinforcement float,
  learning_rate float default 0.1,
  decay_rate float default 0.01
)
returns float
language plpgsql
as $$
declare
  current_weight float;
  new_weight float;
  time_decay float;
  hours_since_activation float;
begin
  select weight, extract(epoch from (now() - last_activated_at)) / 3600
  into current_weight, hours_since_activation
  from hebbian_associations
  where id = assoc_id;
  
  -- Apply time-based decay
  time_decay = exp(-decay_rate * hours_since_activation);
  current_weight = current_weight * time_decay;
  
  -- Apply Hebbian update rule: w_new = w_old + lr * (reinforcement - w_old)
  new_weight = current_weight + learning_rate * (reinforcement - current_weight);
  
  -- Clamp to valid range
  new_weight = greatest(0, least(1, new_weight));
  
  -- Update the association
  update hebbian_associations
  set weight = new_weight,
      activation_count = activation_count + 1,
      last_activated_at = now()
  where id = assoc_id;
  
  return new_weight;
end;
$$;

-- Function: Get relevant context for a thread
create or replace function get_thread_context(
  target_thread_id uuid,
  max_tokens int default 4000
)
returns table (context_id uuid, context_type text, content text, relevance_score float)
language sql stable
as $$
  select id, context_type, content, relevance_score
  from thread_contexts
  where thread_id = target_thread_id
  order by relevance_score desc nulls last, created_at desc
  limit max_tokens / 100;  -- Rough estimate: 100 chars per context item
$$;
