-- 001_extensions.sql
-- Enable required PostgreSQL extensions for ghagga

-- pgvector: Vector similarity search for embeddings
create extension if not exists vector;

-- pg_trgm: Trigram matching for fuzzy text search
create extension if not exists pg_trgm;
