# Environment Variables

This document lists all environment variables required for the GHAGGA project.

## Table of Contents

1. [GitHub App Configuration](#github-app-configuration)
2. [Supabase Configuration](#supabase-configuration)
3. [LLM Provider Configuration](#llm-provider-configuration)
4. [Application Settings](#application-settings)
5. [Example .env File](#example-env-file)

---

## GitHub App Configuration

These variables are obtained during the [GitHub App setup process](./GITHUB_APP_SETUP.md).

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_APP_ID` | Yes | The App ID from your GitHub App settings |
| `GITHUB_CLIENT_ID` | Yes | The Client ID from your GitHub App settings |
| `GITHUB_CLIENT_SECRET` | Yes | The Client Secret (generate in app settings) |
| `GITHUB_PRIVATE_KEY` | Yes | Base64-encoded private key (.pem file) |
| `GITHUB_WEBHOOK_SECRET` | Yes | Secret for validating webhook signatures |
| `GITHUB_INSTALLATION_ID` | No | Default installation ID (optional) |

### How to Obtain

1. **GITHUB_APP_ID**: Found at the top of your GitHub App's settings page
2. **GITHUB_CLIENT_ID**: Listed in the "About" section of your app settings
3. **GITHUB_CLIENT_SECRET**: Click "Generate a new client secret" in app settings
4. **GITHUB_PRIVATE_KEY**: Generate and download, then convert to base64
5. **GITHUB_WEBHOOK_SECRET**: The secret you set during webhook configuration

---

## Supabase Configuration

Variables for connecting to your Supabase project.

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Public anonymous key for client-side access |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key for server-side operations |
| `SUPABASE_JWT_SECRET` | No | JWT secret for custom token verification |

### How to Obtain

1. Go to your Supabase project dashboard
2. Navigate to **Settings** > **API**
3. Copy the values from:
   - **Project URL** → `SUPABASE_URL`
   - **anon public** key → `SUPABASE_ANON_KEY`
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY`

---

## LLM Provider Configuration

Configure your AI/LLM providers for multi-agent review.

### OpenAI

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | No* | API key for OpenAI models |
| `OPENAI_ORG_ID` | No | Organization ID (if applicable) |

### Anthropic

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | No* | API key for Claude models |

### Google AI (Gemini)

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_AI_API_KEY` | No* | API key for Gemini models |

### Azure OpenAI

| Variable | Required | Description |
|----------|----------|-------------|
| `AZURE_OPENAI_API_KEY` | No* | API key for Azure OpenAI |
| `AZURE_OPENAI_ENDPOINT` | No* | Azure OpenAI endpoint URL |
| `AZURE_OPENAI_DEPLOYMENT` | No* | Deployment name |

*At least one LLM provider must be configured.

---

## Application Settings

General application configuration.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | Environment: `development`, `production`, `test` |
| `LOG_LEVEL` | No | `info` | Logging level: `debug`, `info`, `warn`, `error` |
| `MAX_CONCURRENT_REVIEWS` | No | `5` | Maximum parallel review processes |
| `REVIEW_TIMEOUT_MS` | No | `300000` | Timeout for review operations (5 min) |

---

## Example .env File

Create a `.env` file in the project root (never commit this file):

```bash
# ===========================================
# GitHub App Configuration
# ===========================================
GITHUB_APP_ID=123456
GITHUB_CLIENT_ID=Iv1.abc123def456
GITHUB_CLIENT_SECRET=your_client_secret_here
GITHUB_PRIVATE_KEY=LS0tLS1CRUdJTi... (base64 encoded)
GITHUB_WEBHOOK_SECRET=your_webhook_secret_here

# ===========================================
# Supabase Configuration
# ===========================================
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# ===========================================
# LLM Providers (configure at least one)
# ===========================================
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_AI_API_KEY=AIza...

# ===========================================
# Application Settings
# ===========================================
NODE_ENV=development
LOG_LEVEL=info
```

---

## Setting Environment Variables

### Local Development

1. Copy the example above to `.env` in the project root
2. Fill in your actual values
3. The application will load these automatically

### Supabase Edge Functions

Set secrets using the Supabase CLI:

```bash
# Set individual secrets
supabase secrets set GITHUB_APP_ID=123456
supabase secrets set GITHUB_PRIVATE_KEY="$(cat private-key.pem | base64 -w 0)"

# Or set multiple from a file
supabase secrets set --env-file .env.production
```

### Vercel (if applicable)

```bash
vercel env add GITHUB_APP_ID
# Follow prompts to enter value
```

### GitHub Actions (for CI/CD)

Add secrets in your repository settings:
1. Go to **Settings** > **Secrets and variables** > **Actions**
2. Click **New repository secret**
3. Add each variable

---

## Security Notes

1. **Never commit `.env` files** - Add `.env*` to `.gitignore`
2. **Use different keys per environment** - Separate dev/staging/production
3. **Rotate secrets regularly** - Especially after team changes
4. **Limit access** - Only share secrets with those who need them
5. **Audit usage** - Monitor API key usage for anomalies

---

## Validation

Use this script to validate required environment variables:

```typescript
const required = [
  'GITHUB_APP_ID',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];

const missing = required.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.error('Missing required environment variables:', missing);
  process.exit(1);
}
```
