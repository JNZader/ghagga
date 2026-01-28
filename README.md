# GGA GitHub App

GitHub App built with Supabase Edge Functions.

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli)
- [Deno](https://deno.land/)

## Setup

1. Copy environment variables:
   ```bash
   cp supabase/.env.example supabase/.env
   ```

2. Start Supabase locally:
   ```bash
   supabase start
   ```

3. Deploy functions:
   ```bash
   supabase functions deploy
   ```

## Project Structure

```
supabase/
├── config.toml          # Supabase configuration
├── functions/           # Edge Functions
│   └── _shared/         # Shared utilities
└── migrations/          # Database migrations
```

## Development

```bash
# Start local development
supabase start

# Serve functions locally
supabase functions serve

# Run tests
deno test
```
