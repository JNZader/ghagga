# Self-Hosted Deployment Guide

Complete step-by-step guide to deploy GHAGGA with full capabilities: webhook reviews, project memory, dashboard, and static analysis tools.

## Prerequisites

- **Docker** and **Docker Compose** installed
- A **GitHub account** (to create a GitHub App)
- An **Inngest account** (free tier — [inngest.com](https://www.inngest.com/))
- **Optional**: LLM API key from Anthropic, OpenAI, Google, or Qwen. For GitHub Models in server mode, use a PAT with `models:read`.

## Overview

By the end of this guide you'll have:

```mermaid
flowchart LR
  GH["GitHub PR Event"] --> Server["GHAGGA Server<br/>port 3000"]
  Server --> PG["PostgreSQL<br/>port 5432"]
  Server --> Inngest["Inngest<br/>async processing"]
  Server --> LLM["LLM Provider<br/>Anthropic / OpenAI / Google"]
  Server --> Comment["PR Comment"]
```

---

## Step 1: Create a GitHub App

The GitHub App is how GHAGGA receives webhook events and posts review comments on PRs.

### 1.1 Go to GitHub App creation page

Navigate to: **[github.com/settings/apps/new](https://github.com/settings/apps/new)**

> If you want the app under an organization, go to: `github.com/organizations/{org}/settings/apps/new`

### 1.2 Fill in basic info

| Field | Value |
|-------|-------|
| **GitHub App name** | `GHAGGA` (or any unique name) |
| **Homepage URL** | `https://github.com/JNZader/ghagga` |
| **Webhook URL** | `https://your-domain.com/webhook` (you'll update this later) |
| **Webhook secret** | Generate one now — run this in your terminal: |

```bash
openssl rand -hex 20
```

Copy the output (e.g., `a1b2c3d4e5f6...`). You'll need it for `GITHUB_WEBHOOK_SECRET`.

### 1.3 Set permissions

Under **Repository permissions**:

| Permission | Access |
|-----------|--------|
| **Pull requests** | Read and write |
| **Actions** | Write |
| **Secrets** | Read and write |
| **Metadata** | Read-only (auto-selected) |

Under **Account permissions**: Leave everything as "No access".

### 1.4 Subscribe to events

Check the following under **Subscribe to events**:

- [x] **Pull request**
- [x] **Issue comment** — enables on-demand review via `ghagga review` comments

### 1.5 Where can this GitHub App be installed?

Select: **"Only on this account"** (for now — you can change later).

### 1.6 Create the App

Click **"Create GitHub App"**. You'll be redirected to the app's settings page.

### 1.7 Save the App ID

At the top of the settings page, you'll see:

```
App ID: 123456
```

Save this — it's your `GITHUB_APP_ID`.

### 1.8 Generate a Private Key

Scroll to **"Private keys"** and click **"Generate a private key"**.

A `.pem` file will be downloaded. **Base64-encode it** for the environment variable:

```bash
# macOS / Linux
cat your-app-name.2024-01-01.private-key.pem | base64 -w 0
```

```bash
# If the above doesn't work (macOS without -w flag)
cat your-app-name.2024-01-01.private-key.pem | base64
```

Copy the entire base64 string (one long line, no line breaks). This is your `GITHUB_PRIVATE_KEY`.

> **Keep the `.pem` file safe.** If you lose it, you'll need to generate a new one.

### 1.8b Save the OAuth credentials (for Dashboard login)

On the same GitHub App settings page, under **"Client ID"**, copy the value — this is your `GITHUB_CLIENT_ID`.

Then click **"Generate a new client secret"** and copy the value immediately — this is your `GITHUB_CLIENT_SECRET`.

> **Keep the client secret safe.** You won't be able to see it again.

Also configure the **OAuth callback URL**:
- Under **"Callback URL"**, enter: `https://your-domain.com/auth/callback`

### 1.9 Install the App on your repositories

Go to: `https://github.com/settings/apps/YOUR-APP-NAME/installations`

Click **"Install"** and select which repositories GHAGGA should have access to. You can choose "All repositories" or select specific ones.

---

## Step 2: Create an Inngest Account

Inngest handles the async webhook processing. Without it, GHAGGA falls back to synchronous execution (which may timeout on large PRs).

### 2.1 Sign up

Go to **[inngest.com](https://www.inngest.com/)** and create a free account.

Free tier includes **50,000 events/month** — more than enough for most teams.

### 2.2 Create an App

In the Inngest dashboard:

1. Click **"Create App"** (or use the default app)
2. Go to **"Manage"** → **"Signing Key"**
3. Copy the **Signing Key** — this is your `INNGEST_SIGNING_KEY`
4. Go to **"Manage"** → **"Event Keys"**
5. Create a new event key or copy the default one — this is your `INNGEST_EVENT_KEY`

### 2.3 Set up the Inngest webhook

After deploying GHAGGA (Step 4), you'll need to register the Inngest endpoint:

- In Inngest dashboard, go to **"Manage"** → **"Apps"**
- Click **"Sync new app"**
- Enter: `https://your-domain.com/api/inngest`
- Click **"Sync"**

---

## Step 3: Generate Security Keys

### 3.1 Encryption Key

Used to encrypt LLM API keys at rest with AES-256-GCM:

```bash
openssl rand -hex 32
```

This outputs a 64-character hex string. Save it as `ENCRYPTION_KEY`.

> **This key encrypts all stored API keys.** If you lose it, users will need to re-enter their API keys.

### 3.1b State Secret (OAuth CSRF protection)

Used to sign the OAuth state parameter for CSRF protection:

```bash
openssl rand -hex 32
```

Save this as `STATE_SECRET`.

### 3.2 Summary of all credentials

By now you should have all of these:

| Variable | Source | Example |
|----------|--------|---------|
| `GITHUB_APP_ID` | Step 1.7 | `123456` |
| `GITHUB_PRIVATE_KEY` | Step 1.8 | `LS0tLS1CRUdJTi...` (base64) |
| `GITHUB_WEBHOOK_SECRET` | Step 1.2 | `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2` |
| `INNGEST_EVENT_KEY` | Step 2.2 | `evt_xxxx` |
| `INNGEST_SIGNING_KEY` | Step 2.2 | `signkey-xxxx` |
| `ENCRYPTION_KEY` | Step 3.1 | `a1b2c3d4...` (64 hex chars) |
| `GITHUB_CLIENT_ID` | Step 1.8b | `Ov23li...` |
| `GITHUB_CLIENT_SECRET` | Step 1.8b | `abcdef...` (keep secret!) |
| `STATE_SECRET` | Step 3.1b | `a1b2c3d4...` (64 hex chars) |

---

## Step 4: Deploy

Choose your deployment method:

### Option A: Docker Compose (VPS / Local)

Best for: Running on your own server, local development, or a VPS.

#### 4A.1 Clone the repository

```bash
git clone https://github.com/JNZader/ghagga.git
cd ghagga
```

#### 4A.2 Create the `.env` file

```bash
cp .env.example .env
```

Edit `.env` and fill in all the credentials from Step 3.2:

```bash
# Database (provided by Docker Compose — don't change)
DATABASE_URL=postgresql://ghagga:ghagga_dev@postgres:5432/ghagga

# GitHub App
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY=LS0tLS1CRUdJTi...
GITHUB_WEBHOOK_SECRET=a1b2c3d4e5f6...
GITHUB_CLIENT_ID=Ov23li...
GITHUB_CLIENT_SECRET=abcdef...

# Inngest
INNGEST_EVENT_KEY=evt_xxxx
INNGEST_SIGNING_KEY=signkey-xxxx

# Encryption
ENCRYPTION_KEY=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2
STATE_SECRET=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6

# Server
PORT=3000
NODE_ENV=production
```

#### 4A.3 Start the services

```bash
docker compose up -d
```

This starts:
- **PostgreSQL 16** on port 5432 (with health checks and persistent volume)
- **GHAGGA Server** on port 3000 (with 15 static analysis tools pre-installed, Docker `HEALTHCHECK` enabled)

#### 4A.4 Verify it's running

```bash
# Check container status
docker compose ps

# Check server health
curl http://localhost:3000/health
# Should return: {"status":"ok"}

# Check logs
docker compose logs server -f
```

#### 4A.5 Expose to the internet

GHAGGA needs a public URL for GitHub webhooks. Options:

| Method | Best For |
|--------|----------|
| **Reverse proxy** (nginx, Caddy, Traefik) | Production VPS |
| **ngrok** (`ngrok http 3000`) | Local testing |
| **Cloudflare Tunnel** | Production without opening ports |

Example with **Caddy** (auto-HTTPS):

```
ghagga.yourdomain.com {
    reverse_proxy localhost:3000
}
```

#### 4A.6 Update the webhook URL

Go back to your GitHub App settings (Step 1) and update the **Webhook URL** to:

```
https://ghagga.yourdomain.com/webhook
```

Also update the Inngest webhook (Step 2.3):

```
https://ghagga.yourdomain.com/api/inngest
```

---

## Step 5: Verify the Deployment

### 5.1 Health check

```bash
curl https://your-domain.com/health
```

Expected response:

```json
{"status":"ok"}
```

### 5.2 Test the webhook

Create a test Pull Request on a repository where you installed the GitHub App. You should see:

1. **In GHAGGA server logs**: A webhook event received
2. **In Inngest dashboard**: An event `ghagga/review.requested` processed
3. **On the PR**: A review comment posted by GHAGGA

### 5.3 Check the dashboard

Navigate to `https://your-domain.com` (or use the [GitHub Pages dashboard](https://jnzader.github.io/ghagga/app/) with your server URL configured).

Log in with your GitHub account (OAuth) or a Personal Access Token. OAuth login requires `GITHUB_CLIENT_SECRET` and `STATE_SECRET` to be configured.

---

## Step 6: Configure Repositories

Once deployed, configure your LLM providers:

1. Open the GHAGGA dashboard
2. Go to **Global Settings** to set installation-wide defaults
3. Configure a **provider chain** — ordered list of providers with fallback (e.g., GitHub Models → OpenAI → Anthropic)
4. Each provider needs an API key or token. For **GitHub Models** in server mode, use a PAT with `models:read` because GitHub App installation tokens do not have that scope.
5. Choose review mode (Simple, Workflow, or Consensus)
6. Configure which static analysis tools to enable
7. Individual repos can override global settings via **Settings** → toggle "Use global settings" off

---

## Step 6.5: Configure Runner (Optional)

For self-hosted deployments running on machines with 1GB+ RAM, static analysis tools run directly inside the Docker container — no runner needed.

For deployments on limited-memory platforms (like Render free tier), delegate static analysis to a runner:

1. Each user creates a public repo from [`JNZader/ghagga-runner-template`](https://github.com/JNZader/ghagga-runner-template) named `ghagga-runner`
2. The server auto-discovers runner repos by convention (`GET /repos/{owner}/ghagga-runner`)
3. The server needs the callback endpoint accessible: `https://your-domain.com/runner/callback`

The runner setup is per-user — each GitHub user/org that installs GHAGGA can have their own runner repo.

> **Note**: The SaaS Dashboard has an "Enable Runner" button that auto-creates the runner repo via the GitHub Template API. This feature is **SaaS-only** — self-hosted users must create the runner repo manually from the template as described above.

---

## Troubleshooting

### Webhook not received

- Verify the webhook URL matches exactly: `https://your-domain.com/webhook`
- Check the webhook secret matches `GITHUB_WEBHOOK_SECRET`
- In GitHub App settings → **"Advanced"** → **"Recent Deliveries"**, check for failed deliveries
- Ensure your server is publicly accessible (not behind a firewall)

### Inngest events not processing

- Verify `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` are correct
- Check that you synced the app in Inngest dashboard (Step 2.3)
- In Inngest dashboard → **"Events"**, look for `ghagga/review.requested` events

### Server won't start

The server validates all required environment variables (`DATABASE_URL`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `ENCRYPTION_KEY`) at startup. If any are missing, it exits immediately with a clear error message listing the missing vars.

```bash
# Check logs
docker compose logs server

# Common issues:
# - Missing required env vars → server exits with "Missing required env vars: ..." message
# - DATABASE_URL is wrong → check PostgreSQL is running first
# - GITHUB_PRIVATE_KEY is not base64-encoded → re-encode it
# - ENCRYPTION_KEY is not 64 hex characters → regenerate with openssl
```

### Static analysis tools not working

```bash
# Check tools via the diagnostic endpoint
curl https://your-domain.com/health/tools

# Or check directly in the container
docker compose exec server semgrep --version
docker compose exec server trivy --version
docker compose exec server pmd --version
```

If any tool is missing or fails, the review continues without it (graceful degradation).

> **Memory requirements**: Semgrep (Python) and PMD/CPD (Java) need >512MB RAM. On hosting plans with limited memory (e.g., Render free tier at 512MB), static analysis is delegated to a [runner](runner-architecture.md) instead. If running Docker locally with 1GB+ RAM, all tools work directly in the container.

---

## Architecture of the Deployment

```mermaid
flowchart TB
  subgraph GitHub
    PR["Pull Request Event"]
    Runner["ghagga-runner<br/>GitHub Actions"]
  end

  subgraph Docker["Docker Compose"]
    Server["GHAGGA Server<br/>Hono · port 3000"]
    PG["PostgreSQL 16<br/>port 5432"]
  end

  subgraph External
    Inngest["Inngest<br/>async processing"]
    LLM["LLM Provider<br/>Anthropic / OpenAI / Google"]
  end

  PR -->|webhook| Server
  Server -->|workflow_dispatch| Runner
  Runner -->|callback| Server
  Server --> PG
  Server --> Inngest
  Inngest --> Server
  Server --> LLM
  Server -->|PR comment| GitHub
```

## Updating

To update to the latest version:

```bash
cd ghagga
git pull
docker compose build
docker compose up -d
```

The PostgreSQL data is persisted in a Docker volume (`pgdata`) and survives rebuilds.
