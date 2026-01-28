# Deployment Guide

This document describes how to deploy GHAGGA Edge Functions to Supabase.

## Table of Contents

1. [Automated Deployment](#automated-deployment)
2. [GitHub Actions Secrets](#github-actions-secrets)
3. [Manual Deployment](#manual-deployment)

---

## Automated Deployment

The project uses GitHub Actions to automatically deploy Edge Functions when changes are pushed to `main`.

### Trigger Conditions

The deployment workflow runs when:

- Changes are pushed to `main` branch affecting:
  - `supabase/functions/**`
  - `supabase/migrations/**`
  - `.github/workflows/deploy-functions.yml`
- Manually triggered via GitHub Actions UI (workflow_dispatch)

### Deployment Steps

1. Checkout repository
2. Setup Supabase CLI
3. Link to Supabase project
4. Run database migrations
5. Deploy all Edge Functions
6. Set function secrets

---

## GitHub Actions Secrets

Configure these secrets in your repository: **Settings** > **Secrets and variables** > **Actions**

### Required Secrets

| Secret | Description | How to Obtain |
|--------|-------------|---------------|
| `SUPABASE_ACCESS_TOKEN` | Personal access token for Supabase CLI | [Supabase Dashboard](https://supabase.com/dashboard/account/tokens) > Access Tokens |
| `SUPABASE_PROJECT_ID` | Your Supabase project reference ID | Dashboard URL: `https://supabase.com/dashboard/project/<PROJECT_ID>` |
| `SUPABASE_DB_PASSWORD` | Database password for migrations | Project Settings > Database > Connection string password |

### Function Secrets

These secrets are set on the Edge Functions during deployment:

| Secret | Description |
|--------|-------------|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_CLIENT_ID` | GitHub App Client ID |
| `GITHUB_CLIENT_SECRET` | GitHub App Client Secret |
| `GITHUB_PRIVATE_KEY` | Base64-encoded GitHub App private key |
| `GITHUB_WEBHOOK_SECRET` | Webhook signature verification secret |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `OPENAI_API_KEY` | OpenAI API key (optional) |
| `ANTHROPIC_API_KEY` | Anthropic API key (optional) |
| `GOOGLE_AI_API_KEY` | Google AI API key (optional) |

See [ENV_VARIABLES.md](./ENV_VARIABLES.md) for detailed information on each variable.

### Adding Secrets

1. Go to your GitHub repository
2. Navigate to **Settings** > **Secrets and variables** > **Actions**
3. Click **New repository secret**
4. Add each secret listed above

---

## Manual Deployment

For local or manual deployments:

### Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) installed
- Supabase access token configured

### Steps

```bash
# Login to Supabase
supabase login

# Link to your project
supabase link --project-ref <PROJECT_ID>

# Run migrations
supabase db push

# Deploy functions
supabase functions deploy

# Set secrets (from .env file)
supabase secrets set --env-file .env.production
```

### Deploy Individual Functions

```bash
# Deploy specific function
supabase functions deploy webhook
supabase functions deploy review
```

---

## Troubleshooting

### Migration Failures

If migrations fail:

1. Check the migration SQL syntax
2. Verify database password is correct
3. Check for conflicting schema changes

### Function Deployment Failures

If function deployment fails:

1. Verify `import_map.json` is valid
2. Check for TypeScript errors in function code
3. Ensure all dependencies are properly imported

### Secret Issues

If functions fail due to missing secrets:

1. Verify all secrets are set in GitHub Actions
2. Check secret names match exactly (case-sensitive)
3. Re-run the deployment workflow after adding secrets
