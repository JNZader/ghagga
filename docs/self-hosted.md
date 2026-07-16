# Self-Hosted Deployment Guide

Complete step-by-step guide to deploy GHAGGA on a Hetzner VPS with Coolify, using Docker Compose for all services: API server, worker, PostgreSQL, and Redis.

## Prerequisites

- A **Hetzner VPS** (or any Linux server with 2GB+ RAM) — CX22 or higher recommended
- A **GitHub account** (to create a GitHub App)
- **Optional**: LLM API key from Anthropic, OpenAI, Google, or Qwen. For GitHub Models in server mode, use a PAT with `models:read`.

## Overview

By the end of this guide you'll have:

```mermaid
flowchart LR
  GH["GitHub PR Event"] --> Server["GHAGGA Server<br/>port 3000"]
  Server --> Worker["GHAGGA Worker<br/>BullMQ"]
  Worker --> PG["PostgreSQL<br/>port 5432"]
  Worker --> Redis["Redis<br/>port 6379"]
  Worker --> LLM["LLM Provider<br/>Anthropic / OpenAI / Google"]
  Worker --> Comment["PR Comment"]
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

| Permission | Access | Why |
|-----------|--------|-----|
| **Pull requests** | Read and write | Fetch PR diffs and post review comments |
| **Contents** | Read and write | Inject the static-analysis workflow file at `.github/workflows/ghagga.yml` |
| **Actions** | Write | Dispatch the injected workflow via `workflow_dispatch` |
| **Issues** | Read and write | Issue-triage (`/ghagga triage`): read the issue + its comments, post the approved draft comment |
| **Metadata** | Read-only (auto-selected) | List repositories and installations |

Under **Account permissions**: Leave everything as "No access".

> **Note**: GHAGGA does **not** require the `Secrets: Read and write` permission. The static-analysis runner is an inline workflow injected into each target repo; the per-dispatch callback secret travels via `workflow_dispatch` inputs, not via GitHub Actions repository secrets.

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

## Step 2: Generate Security Keys

### 2.1 Encryption Key

Used to encrypt LLM API keys at rest with AES-256-GCM:

```bash
openssl rand -hex 32
```

This outputs a 64-character hex string. Save it as `ENCRYPTION_KEY`.

> **This key encrypts all stored API keys.** If you lose it, users will need to re-enter their API keys.

### 2.2 State Secret (OAuth CSRF protection)

Used to sign the OAuth state parameter for CSRF protection and runner callback HMAC derivation:

```bash
openssl rand -hex 32
```

Save this as `STATE_SECRET`.

### 2.3 Summary of all credentials

By now you should have all of these:

| Variable | Source | Example |
|----------|--------|---------|
| `GITHUB_APP_ID` | Step 1.7 | `123456` |
| `GITHUB_PRIVATE_KEY` | Step 1.8 | `LS0tLS1CRUdJTi...` (base64) |
| `GITHUB_WEBHOOK_SECRET` | Step 1.2 | `a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2` |
| `ENCRYPTION_KEY` | Step 2.1 | `a1b2c3d4...` (64 hex chars) |
| `GITHUB_CLIENT_ID` | Step 1.8b | `Ov23li...` |
| `GITHUB_CLIENT_SECRET` | Step 1.8b | `abcdef...` (keep secret!) |
| `STATE_SECRET` | Step 2.2 | `a1b2c3d4...` (64 hex chars) |

---

## Step 3: Set Up Hetzner VPS

### 3.1 Create a VPS

1. Go to [Hetzner Cloud Console](https://console.hetzner.cloud/)
2. Create a new project (or use an existing one)
3. Create a server:
   - **Location**: Choose closest to your team
   - **Image**: Ubuntu 22.04 or 24.04
   - **Type**: CX22 (2 vCPU, 4GB RAM) or higher recommended
   - **Networking**: Enable public IPv4
   - **SSH Key**: Add your SSH public key

4. Note the server's public IP address

### 3.2 Point your domain

Create a DNS A record pointing your domain to the server IP:

```
api.yourdomain.com  ->  YOUR_SERVER_IP
```

---

## Step 4: Install Coolify

[Coolify](https://coolify.io/) is a self-hosted PaaS that manages Docker deployments, SSL certificates, and environment variables.

### 4.1 SSH into your server

```bash
ssh root@YOUR_SERVER_IP
```

### 4.2 Install Coolify

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

This installs Coolify and all dependencies (Docker, Docker Compose, Traefik). The installation takes 2-5 minutes.

### 4.3 Access Coolify dashboard

Open `http://YOUR_SERVER_IP:8000` in your browser and complete the initial setup:

1. Create your admin account
2. Configure your server (localhost is auto-detected)

---

## Step 5: Deploy GHAGGA via Coolify

### 5.1 Create a new project in Coolify

In the Coolify dashboard:
1. Click **"New Project"**
2. Name it `ghagga`

### 5.2 Deploy using Docker Compose

GHAGGA's `docker-compose.yml` defines four services:

| Service | Role | Description |
|---------|------|-------------|
| **server** | API | Hono HTTP server — receives webhooks, serves dashboard API |
| **worker** | Queue processor | BullMQ worker — processes review jobs from the Redis queue |
| **postgres** | Database | PostgreSQL 16 with persistent volume |
| **redis** | Queue backend | Redis 7 for BullMQ job queues |

In Coolify:
1. Add a new resource → **Docker Compose**
2. Connect your GitHub repository (`JNZader/ghagga`) or paste the `docker-compose.yml` content
3. Coolify will detect the services automatically

### 5.3 Configure environment variables

In Coolify's environment variables section, add all credentials from Step 2.3:

```bash
# Database (provided by Docker Compose — don't change)
DATABASE_URL=postgresql://ghagga:ghagga_dev@postgres:5432/ghagga

# Redis (provided by Docker Compose — don't change)
REDIS_URL=redis://redis:6379

# GitHub App
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY=LS0tLS1CRUdJTi...
GITHUB_WEBHOOK_SECRET=a1b2c3d4e5f6...
GITHUB_CLIENT_ID=Ov23li...
GITHUB_CLIENT_SECRET=abcdef...

# Encryption
ENCRYPTION_KEY=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2
STATE_SECRET=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6

# Server
PORT=3000
NODE_ENV=production
SERVER_URL=https://api.yourdomain.com
WORKER_CONCURRENCY=3
```

### 5.4 Configure domain and SSL

In Coolify:
1. Go to the **server** service settings
2. Set the domain to `api.yourdomain.com`
3. Coolify auto-provisions SSL via Let's Encrypt through its built-in Traefik proxy

### 5.5 Deploy

Click **"Deploy"**. Coolify builds the Docker images and starts all four services.

---

## Alternative: Manual Docker Compose (without Coolify)

If you prefer to deploy directly without Coolify:

### Clone and configure

```bash
git clone https://github.com/JNZader/ghagga.git
cd ghagga
cp .env.example .env
# Edit .env with your credentials (see Step 5.3 above)
```

### Start the services

```bash
docker compose up -d
```

This starts all four services: PostgreSQL, Redis, GHAGGA server, and GHAGGA worker.

### Expose with a reverse proxy

Use Caddy (auto-HTTPS), nginx, or Traefik:

```
# Caddyfile example
api.yourdomain.com {
    reverse_proxy localhost:3000
}
```

---

## Step 6: Update GitHub App Webhook URL

Go back to your GitHub App settings (Step 1) and update the **Webhook URL** to:

```
https://api.yourdomain.com/webhook
```

---

## Step 7: Verify the Deployment

### 7.1 Health check

```bash
curl https://api.yourdomain.com/health
```

Expected response:

```json
{"status":"ok"}
```

### 7.2 Test the webhook

Create a test Pull Request on a repository where you installed the GitHub App. You should see:

1. **In GHAGGA server logs**: A webhook event received
2. **In worker logs**: A review job processed from the BullMQ queue
3. **On the PR**: A review comment posted by GHAGGA

### 7.3 Check the dashboard

Navigate to the [GitHub Pages dashboard](https://ghagga.javierzader.com/app/) with your server URL configured, or host the dashboard on your own domain.

Log in with your GitHub account (OAuth) or a Personal Access Token. OAuth login requires `GITHUB_CLIENT_SECRET` and `STATE_SECRET` to be configured.

---

## Step 8: Configure Repositories

Once deployed, configure your LLM providers:

1. Open the GHAGGA dashboard
2. Go to **Global Settings** to set installation-wide defaults
3. Configure a **provider chain** — ordered list of providers with fallback (e.g., GitHub Models -> OpenAI -> Anthropic)
4. Each provider needs an API key or token. For **GitHub Models** in server mode, use a PAT with `models:read` because GitHub App installation tokens do not have that scope.
5. Choose review mode (Simple, Workflow, or Consensus)
6. Configure which static analysis tools to enable
7. Individual repos can override global settings via **Settings** -> toggle "Use global settings" off

---

## Step 8.5: Static Analysis Runner

Static analysis runs as an inline GitHub Actions workflow that the server injects into each target repository at `.github/workflows/ghagga.yml` (built from `templates/ghagga-inline.yml`). There is no separate runner repository to provision — the workflow runs on the PR's own repo using the repo's own free GitHub Actions minutes.

The only deployment-side requirement is that the server's callback endpoint must be publicly reachable so the workflow can POST results:

```
https://api.yourdomain.com/runner/callback
```

If you prefer to run static-analysis tools directly inside the Docker container (no GitHub Actions involvement), the server image already ships with Semgrep, Trivy, PMD/CPD, and the other tools pre-installed for direct execution. The inline-workflow path is recommended for SaaS deployments where you want to offload analysis to GitHub's compute.

---

## Troubleshooting

### Webhook not received

- Verify the webhook URL matches exactly: `https://api.yourdomain.com/webhook`
- Check the webhook secret matches `GITHUB_WEBHOOK_SECRET`
- In GitHub App settings -> **"Advanced"** -> **"Recent Deliveries"**, check for failed deliveries
- Ensure your server is publicly accessible (not behind a firewall)

### Worker not processing jobs

- Check that Redis is running: `docker compose logs redis`
- Check worker logs: `docker compose logs worker -f`
- Verify `REDIS_URL` is correct and accessible from the worker container
- Check worker concurrency: default is 3, adjust with `WORKER_CONCURRENCY`

### Server won't start

The server validates all required environment variables (`DATABASE_URL`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `ENCRYPTION_KEY`) at startup. If any are missing, it exits immediately with a clear error message listing the missing vars.

```bash
# Check logs
docker compose logs server

# Common issues:
# - Missing required env vars -> server exits with "Missing required env vars: ..." message
# - DATABASE_URL is wrong -> check PostgreSQL is running first
# - GITHUB_PRIVATE_KEY is not base64-encoded -> re-encode it
# - ENCRYPTION_KEY is not 64 hex characters -> regenerate with openssl
```

### Static analysis tools not working

```bash
# Check tools via the diagnostic endpoint
curl https://api.yourdomain.com/health/tools

# Or check directly in the container
docker compose exec server semgrep --version
docker compose exec server trivy --version
docker compose exec server pmd --version
```

If any tool is missing or fails, the review continues without it (graceful degradation).

> **Memory requirements**: Semgrep (Python) and PMD/CPD (Java) need >512MB RAM. On the recommended Hetzner CX22 (4GB RAM), all tools work directly in the container without needing a runner.

---

## Architecture of the Deployment

```mermaid
flowchart TB
  subgraph GitHub
    PR["Pull Request Event"]
    Inline["Inline workflow<br/>.github/workflows/ghagga.yml<br/>(injected per repo)"]
  end

  subgraph Hetzner["Hetzner VPS (Coolify)"]
    Server["GHAGGA Server<br/>Hono - port 3000"]
    Worker["GHAGGA Worker<br/>BullMQ"]
    PG["PostgreSQL 16<br/>port 5432"]
    Redis["Redis 7<br/>port 6379"]
  end

  subgraph External
    LLM["LLM Provider<br/>Anthropic / OpenAI / Google"]
  end

  PR -->|webhook| Server
  Server -->|enqueue job| Redis
  Redis -->|dequeue job| Worker
  Server -->|inject + workflow_dispatch| Inline
  Inline -->|HMAC callback| Server
  Worker --> PG
  Worker --> LLM
  Worker -->|PR comment| GitHub
```

## Updating

To update to the latest version:

**With Coolify**: Click **"Redeploy"** in the Coolify dashboard after pulling the latest changes.

**Manual Docker Compose**:

```bash
cd ghagga
git pull
docker compose build
docker compose up -d
```

The PostgreSQL data is persisted in a Docker volume (`pgdata`) and survives rebuilds. Redis data is ephemeral (job queues are transient).
