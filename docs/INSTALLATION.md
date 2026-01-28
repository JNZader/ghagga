# Installation Guide

This guide covers the complete setup process for GHAGGA, from prerequisites to a running local instance.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Clone the Repository](#clone-the-repository)
3. [Backend Setup (Supabase)](#backend-setup-supabase)
4. [Frontend Setup (Dashboard)](#frontend-setup-dashboard)
5. [GitHub App Setup](#github-app-setup)
6. [Verification](#verification)
7. [Production Deployment](#production-deployment)

---

## Prerequisites

### Required Software

| Software | Version | Purpose |
|----------|---------|---------|
| [Node.js](https://nodejs.org/) | v18+ | Dashboard development |
| [npm](https://www.npmjs.com/) | v9+ | Package management |
| [Deno](https://deno.land/) | v1.38+ | Edge function runtime |
| [Supabase CLI](https://supabase.com/docs/guides/cli) | v1.100+ | Local development |
| [Docker](https://www.docker.com/) | v20+ | Required by Supabase CLI |
| [Git](https://git-scm.com/) | v2.30+ | Version control |

### Installation Commands

**Node.js** (using nvm):
```bash
# Install nvm (Linux/macOS)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Install Node.js
nvm install 18
nvm use 18
```

**Deno**:
```bash
# macOS/Linux
curl -fsSL https://deno.land/x/install/install.sh | sh

# Windows (PowerShell)
irm https://deno.land/install.ps1 | iex

# Verify installation
deno --version
```

**Supabase CLI**:
```bash
# Using npm
npm install -g supabase

# Using Homebrew (macOS)
brew install supabase/tap/supabase

# Verify installation
supabase --version
```

### API Keys

You will need API keys for at least one LLM provider:

| Provider | Get API Key |
|----------|-------------|
| Anthropic (Claude) | [console.anthropic.com](https://console.anthropic.com/) |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) |
| Google AI (Gemini) | [aistudio.google.com](https://aistudio.google.com/app/apikey) |

---

## Clone the Repository

```bash
# Clone the repository
git clone https://github.com/your-org/ghagga.git
cd ghagga
```

---

## Backend Setup (Supabase)

### 1. Configure Environment Variables

```bash
# Copy the example environment file
cp supabase/.env.example supabase/.env
```

Edit `supabase/.env` with your configuration:

```bash
# Required: GitHub App credentials (see GitHub App Setup section)
GITHUB_APP_ID=your_app_id
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
GITHUB_PRIVATE_KEY=base64_encoded_private_key
GITHUB_WEBHOOK_SECRET=your_webhook_secret

# Required: At least one LLM provider
ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# GOOGLE_AI_API_KEY=AIza...

# Optional: Application settings
NODE_ENV=development
LOG_LEVEL=info
```

See [Environment Variables](ENV_VARIABLES.md) for complete reference.

### 2. Start Supabase

```bash
# Start the local Supabase instance
supabase start
```

This starts several services:

| Service | Port | URL |
|---------|------|-----|
| API | 54321 | http://localhost:54321 |
| Database | 54322 | postgresql://localhost:54322 |
| Studio | 54323 | http://localhost:54323 |
| Inbucket (email) | 54324 | http://localhost:54324 |

After startup, you'll see output with your local credentials:

```
API URL: http://localhost:54321
anon key: eyJhbG...
service_role key: eyJhbG...
```

Save these values for the dashboard configuration.

### 3. Run Database Migrations

Migrations run automatically on `supabase start`. To verify:

```bash
# Check migration status
supabase db push --dry-run

# View applied migrations
supabase migration list
```

### 4. Deploy Edge Functions

```bash
# Deploy all functions
supabase functions deploy

# Or deploy specific functions
supabase functions deploy webhook
supabase functions deploy review
```

### 5. Set Function Secrets

```bash
# Set secrets for edge functions
supabase secrets set GITHUB_APP_ID=your_app_id
supabase secrets set GITHUB_PRIVATE_KEY="$(cat private-key.pem | base64 -w 0)"
supabase secrets set GITHUB_WEBHOOK_SECRET=your_webhook_secret
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

---

## Frontend Setup (Dashboard)

### 1. Install Dependencies

```bash
cd dashboard
npm install
```

### 2. Configure Environment

Create `dashboard/.env.local`:

```bash
# Use the values from supabase start output
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=eyJhbG...
```

### 3. Start Development Server

```bash
npm run dev
```

The dashboard will be available at: **http://localhost:5173/ghagga/**

### 4. Build for Production

```bash
# Type check and build
npm run build

# Preview production build
npm run preview
```

---

## GitHub App Setup

Follow the detailed guide at [GITHUB_APP_SETUP.md](GITHUB_APP_SETUP.md).

Quick summary:

1. Create a GitHub App at [github.com/settings/apps](https://github.com/settings/apps)
2. Configure permissions:
   - Repository: Contents (Read), Pull requests (Read & Write), Metadata (Read)
3. Set webhook URL to your Supabase function endpoint
4. Generate and save credentials
5. Install the app on target repositories

---

## Verification

### Test Local Setup

1. **Database**: Visit [http://localhost:54323](http://localhost:54323) (Supabase Studio)
2. **Dashboard**: Visit [http://localhost:5173/ghagga/](http://localhost:5173/ghagga/)
3. **Functions**: Test the webhook endpoint:

```bash
curl -X POST http://localhost:54321/functions/v1/webhook \
  -H "Content-Type: application/json" \
  -H "x-github-event: ping" \
  -d '{"zen": "test"}'
```

### Test GitHub Integration

1. Install your GitHub App on a test repository
2. Create a pull request
3. Check the Supabase function logs: `supabase functions logs webhook`
4. Verify the review appears in the dashboard

---

## Production Deployment

### Supabase Hosted

1. Create a project at [supabase.com](https://supabase.com)
2. Link your local project:
   ```bash
   supabase link --project-ref your-project-ref
   ```
3. Push migrations:
   ```bash
   supabase db push
   ```
4. Deploy functions:
   ```bash
   supabase functions deploy
   ```
5. Set production secrets:
   ```bash
   supabase secrets set --env-file .env.production
   ```

### Dashboard Hosting

Deploy the dashboard to any static hosting service:

**Vercel**:
```bash
npm i -g vercel
cd dashboard
vercel
```

**Netlify**:
```bash
npm i -g netlify-cli
cd dashboard
npm run build
netlify deploy --prod --dir=dist
```

### Update GitHub App Webhook URL

After deploying, update your GitHub App's webhook URL to point to your production Supabase function:

```
https://your-project.supabase.co/functions/v1/webhook
```

---

## Troubleshooting

### Supabase Won't Start

```bash
# Reset and restart
supabase stop
supabase start --ignore-health-check
```

### Database Connection Issues

```bash
# Check status
supabase status

# Reset database
supabase db reset
```

### Function Deployment Fails

```bash
# Check logs
supabase functions logs webhook --tail

# Verify Deno syntax
deno check supabase/functions/webhook/index.ts
```

### Dashboard Build Errors

```bash
# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install
npm run build
```

---

## Next Steps

- [Configure your repositories](CONFIGURATION.md)
- [Understand the API](API.md)
- [Set up environment variables](ENV_VARIABLES.md)
