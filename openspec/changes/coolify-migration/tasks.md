# Tasks: Migración a Coolify (Self-Hosted)

## Part of: coolify-migration

## Phase 1: Infrastructure Setup

### Task 1.1: Create Hetzner Account
**Status**: pending
**Assignee**: User
**Estimated**: 10 min
**Dependencies**: None

**Steps**:
1. [ ] Go to https://hetzner.com and click "Register"
2. [ ] Fill registration form with email
3. [ ] Verify email address
4. [ ] Add payment method (card charged €1, refunded)
5. [ ] Complete registration

**Verification**:
- Can login to https://console.hetzner.cloud

---

### Task 1.2: Generate SSH Key (if needed)
**Status**: pending
**Assignee**: User
**Estimated**: 2 min
**Dependencies**: None

**Steps**:
1. [ ] Open terminal
2. [ ] Check if key exists: `cat ~/.ssh/id_rsa.pub`
3. [ ] If not exists, generate: `ssh-keygen -t rsa -b 4096`
4. [ ] Copy public key: `cat ~/.ssh/id_rsa.pub | pbcopy` (Mac) or select & copy

**Verification**:
- Public key copied to clipboard

---

### Task 1.3: Create Hetzner Project
**Status**: pending
**Assignee**: User
**Estimated**: 3 min
**Dependencies**: 1.1

**Steps**:
1. [ ] Login to https://console.hetzner.cloud
2. [ ] Click "Add Project"
3. [ ] Name: `ghagga-production`
4. [ ] Click "Create project"
5. [ ] Select project from dropdown

**Verification**:
- Project visible in dashboard

---

### Task 1.4: Add SSH Key to Hetzner
**Status**: pending
**Assignee**: User
**Estimated**: 3 min
**Dependencies**: 1.2, 1.3

**Steps**:
1. [ ] In Hetzner, click "Security" (left sidebar)
2. [ ] Tab "SSH Keys"
3. [ ] Click "Add SSH Key"
4. [ ] Name: `mi-laptop`
5. [ ] Paste public key
6. [ ] Click "Add SSH Key"

**Verification**:
- Key appears in list

---

### Task 1.5: Create CX21 Server
**Status**: pending
**Assignee**: User
**Estimated**: 5 min
**Dependencies**: 1.4

**Steps**:
1. [ ] Click "Servers" (left sidebar)
2. [ ] Click "Add Server"
3. [ ] Configure:
   - Location: Falkenstein
   - Image: Ubuntu 22.04
   - Type: Shared vCPU → CX21
   - Networking: IPv4 + IPv6 (default)
   - SSH Key: Select `mi-laptop`
   - Name: `coolify-server`
4. [ ] Click "Create & Buy Now"
5. [ ] Wait for status "Running"
6. [ ] **Copy the public IP** (e.g., 78.46.123.45)

**Verification**:
- Server shows "Running" status
- IP address noted

---

### Task 1.6: Test SSH Connection
**Status**: pending
**Assignee**: User
**Estimated**: 2 min
**Dependencies**: 1.5

**Steps**:
1. [ ] In terminal: `ssh root@YOUR_IP`
2. [ ] Should connect without password
3. [ ] Run: `exit`

**Verification**:
- Connected successfully
- Saw prompt `root@coolify-server:~#`

---

### Task 1.7: Configure Cloudflare DNS
**Status**: pending
**Assignee**: User
**Estimated**: 5 min
**Dependencies**: 1.5

**Steps**:
1. [ ] Go to https://dash.cloudflare.com
2. [ ] Select your domain
3. [ ] Click "DNS" (left sidebar)
4. [ ] Add record:
   - Type: A
   - Name: `coolify`
   - IPv4: YOUR_HETZNER_IP
   - TTL: Auto
   - Proxy: DNS only (gray)
5. [ ] Add record:
   - Type: A
   - Name: `api`
   - IPv4: YOUR_HETZNER_IP
   - TTL: Auto
   - Proxy: DNS only (gray)
6. [ ] Click "Save" for both

**Verification**:
- `nslookup coolify.yourdomain.com` returns your IP
- `nslookup api.yourdomain.com` returns your IP

---

## Phase 2: Coolify Installation

### Task 2.1: Connect to Server
**Status**: pending
**Assignee**: User
**Estimated**: 2 min
**Dependencies**: 1.6

**Steps**:
1. [ ] `ssh root@YOUR_HETZNER_IP`

**Verification**:
- Connected to server

---

### Task 2.2: Update System
**Status**: pending
**Assignee**: User
**Estimated**: 5 min
**Dependencies**: 2.1

**Steps**:
1. [ ] Run: `apt update && apt upgrade -y`
2. [ ] Wait for completion

**Verification**:
- No errors
- System updated

---

### Task 2.3: Install Coolify
**Status**: pending
**Assignee**: User
**Estimated**: 5 min
**Dependencies**: 2.2

**Steps**:
1. [ ] Run: `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`
2. [ ] Wait 3-5 minutes for installation
3. [ ] Verify: `docker ps` should show Coolify containers

**Verification**:
- Docker containers running
- Coolify installed

---

### Task 2.4: Initial Coolify Setup
**Status**: pending
**Assignee**: User
**Estimated**: 10 min
**Dependencies**: 2.3

**Steps**:
1. [ ] Open browser: `http://YOUR_IP:8000`
2. [ ] Register admin account:
   - Name: Admin
   - Email: your-email@example.com
   - Password: (create secure password)
3. [ ] In wizard:
   - Instance Domain: `coolify.yourdomain.com`
   - Default Redirect: `https://coolify.yourdomain.com`
   - Instance Name: `GHAGGA Production`
4. [ ] Copy the SSH key shown
5. [ ] In new tab: Hetzner → Security → SSH Keys
6. [ ] Add new key named `coolify-deploy`
7. [ ] Return to Coolify, click Continue
8. [ ] Skip email settings (optional)
9. [ ] Validate server
10. [ ] Go to Dashboard

**Verification**:
- Coolify dashboard accessible

---

### Task 2.5: Enable HTTPS
**Status**: pending
**Assignee**: User
**Estimated**: 5 min
**Dependencies**: 2.4

**Steps**:
1. [ ] In Coolify: Settings (gear icon)
2. [ ] Tab "Instance Settings"
3. [ ] Verify Instance Domain: `coolify.yourdomain.com`
4. [ ] SSL/TLS: Toggle "Let's Encrypt" ON
5. [ ] Click "Save"
6. [ ] Wait 1-2 minutes
7. [ ] Refresh: `https://coolify.yourdomain.com`

**Verification**:
- HTTPS works (lock icon in browser)
- No certificate warnings

---

## Phase 3: GitHub Integration

### Task 3.1: Connect GitHub to Coolify
**Status**: pending
**Assignee**: User
**Estimated**: 5 min
**Dependencies**: 2.5

**Steps**:
1. [ ] Coolify → Sources (left sidebar)
2. [ ] Click "GitHub App"
3. [ ] Click "Create a GitHub App"
4. [ ] Name: `coolify-ghagga`
5. [ ] Select your organization
6. [ ] Click "Create"
7. [ ] Click "Install" in GitHub
8. [ ] Select: "Only select repositories"
9. [ ] Choose `ghagga` repository
10. [ ] Click "Install"
11. [ ] Return to Coolify, click "Reload"

**Verification**:
- GitHub App shows "Connected"

---

## Phase 4: Database Setup

### Task 4.1: Create PostgreSQL
**Status**: pending
**Assignee**: User
**Estimated**: 5 min
**Dependencies**: 3.1

**Steps**:
1. [ ] Coolify → New Project
2. [ ] Name: `ghagga`
3. [ ] Click project to enter
4. [ ] Click "+ New Resource"
5. [ ] Select "PostgreSQL"
6. [ ] Configure:
   - Name: `ghagga-db`
   - Version: 16
   - Username: `ghagga`
   - Password: Click "Generate" and COPY
   - Database: `ghagga`
7. [ ] Click "Create"
8. [ ] Wait for "Running" status
9. [ ] Click service to view details
10. [ ] **COPY the DATABASE_URL**

**Verification**:
- Service shows "Running"
- DATABASE_URL noted

---

### Task 4.2: Create Redis
**Status**: pending
**Assignee**: User
**Estimated**: 3 min
**Dependencies**: 4.1

**Steps**:
1. [ ] Back to project → "+ New Resource"
2. [ ] Select "Redis"
3. [ ] Configure:
   - Name: `ghagga-redis`
   - Version: 7
4. [ ] Click "Create"
5. [ ] Wait for "Running"

**Verification**:
- Service shows "Running"
- REDIS_URL noted (should be `redis://ghagga-redis:6379`)

---

## Phase 5: Code Implementation

### Task 5.1: Remove Inngest Dependencies
**Status**: completed
**Assignee**: AI Assistant
**Estimated**: 5 min
**Dependencies**: None

**Files to modify**:
- `apps/server/package.json`

**Steps**:
1. [x] Remove: `inngest` from dependencies
2. [x] Add: `bullmq`, `ioredis`, `node-cron`
3. [x] Add dev: `@types/node-cron`

**Verification**:
- package.json updated
- No references to inngest

---

### Task 5.2: Create Redis Module
**Status**: completed
**Assignee**: AI Assistant
**Estimated**: 5 min
**Dependencies**: 5.1

**Files to create**:
- `apps/server/src/lib/redis.ts`

**Code**:
```typescript
import Redis from 'ioredis';

export const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export default redis;
```

**Verification**:
- File created
- Exports Redis instance

---

### Task 5.3: Create Review Queue
**Status**: completed
**Assignee**: AI Assistant
**Estimated**: 15 min
**Dependencies**: 5.2

**Files to create**:
- `apps/server/src/queues/review.ts`

**Requirements**:
- Define Queue 'review' with options
- Create enqueueReview function
- Create createReviewWorker factory
- Setup queue event handlers
- Full TypeScript typing

**Verification**:
- File created with all functions
- No TypeScript errors

---

### Task 5.4: Create Worker Entry Point
**Status**: completed
**Assignee**: AI Assistant
**Estimated**: 10 min
**Dependencies**: 5.3

**Files to create**:
- `apps/server/src/workers/review.ts`

**Requirements**:
- Import worker factory
- Start worker
- Setup SIGTERM handler
- Log startup

**Verification**:
- File created
- Graceful shutdown implemented

---

### Task 5.5: Modify Webhook Handler
**Status**: completed
**Assignee**: AI Assistant
**Estimated**: 15 min
**Dependencies**: 5.3

**Files to modify**:
- `apps/server/src/routes/webhook.ts`

**Changes**:
1. [ ] Remove Inngest imports
2. [ ] Add BullMQ import
3. [ ] Replace `inngest.send()` with `enqueueReview()`
4. [ ] Keep same response format

**Verification**:
- No Inngest references
- Uses enqueueReview
- Returns 200 immediately

---

### Task 5.6: Create Dockerfile
**Status**: completed
**Assignee**: AI Assistant
**Estimated**: 10 min
**Dependencies**: None

**Files to create**:
- `apps/server/Dockerfile`

**Requirements**:
- Multi-stage build
- Node 20 slim
- Builder stage: install deps, build
- Runner stage: copy dist, prod deps only
- Expose port 3000

**Verification**:
- Dockerfile created
- Optimized layers

---

### Task 5.7: Create Start Script
**Status**: completed
**Assignee**: AI Assistant
**Estimated**: 5 min
**Dependencies**: 5.6

**Files to create**:
- `apps/server/start.sh`

**Requirements**:
- Check SERVICE_TYPE env var
- If "worker": run worker.js
- Else: run server index.js
- Add shebang and make executable

**Verification**:
- Script created
- chmod +x applied

---

### Task 5.8: Create Docker Compose
**Status**: completed
**Assignee**: AI Assistant
**Estimated**: 15 min
**Dependencies**: 5.6, 5.7

**Files to create**:
- `docker-compose.yml` (root)

**Services**:
1. [ ] server (API)
2. [ ] worker (x2 replicas)
3. [ ] postgres
4. [ ] redis
5. [ ] bull-dashboard

**Verification**:
- All 5 services defined
- Health checks configured
- Volumes for persistence

---

### Task 5.9: Update .env.example
**Status**: completed
**Assignee**: AI Assistant
**Estimated**: 5 min
**Dependencies**: 5.8

**Files to modify**:
- `.env.example`

**Changes**:
1. [ ] Remove INNGEST_* variables
2. [ ] Add REDIS_URL, REDIS_HOST, REDIS_PORT
3. [ ] Update comments

**Verification**:
- No Inngest references
- All required vars documented

---

### Task 5.10: Build and Test Locally
**Status**: completed
**Assignee**: AI Assistant
**Estimated**: 10 min
**Dependencies**: 5.5, 5.8, 5.9

**Steps**:
1. [ ] Run: `pnpm install`
2. [ ] Run: `pnpm build`
3. [ ] Verify no TypeScript errors
4. [ ] Verify no lint errors

**Verification**:
- Build succeeds
- No errors

---

## Phase 6: Deployment

### Task 6.1: Push Code to GitHub
**Status**: completed
**Assignee**: User
**Estimated**: 5 min
**Dependencies**: 5.10

**Steps**:
1. [ ] `git add .`
2. [ ] `git commit -m "feat: migrate from Inngest to BullMQ for Coolify"`
3. [ ] `git push origin main`

**Verification**:
- Code pushed
- All files in repo

---

### Task 6.2: Create Application in Coolify
**Status**: pending
**Assignee**: User
**Estimated**: 5 min
**Dependencies**: 6.1

**Steps**:
1. [ ] Coolify → ghagga project
2. [ ] "+ New Resource"
3. [ ] Select "Application"
4. [ ] Select `ghagga` repository
5. [ ] Configure:
   - Name: `ghagga-server`
   - Build Pack: Docker Compose
   - Base Directory: `/`
   - Docker Compose: `docker-compose.yml`
6. [ ] Click "Continue"

**Verification**:
- Application created
- Source connected

---

### Task 6.3: Configure Environment Variables
**Status**: pending
**Assignee**: User
**Estimated**: 10 min
**Dependencies**: 4.1, 4.2, 6.2

**Steps**:
1. [ ] In application → "Environment Variables" tab
2. [ ] Add variables (all from .env with NEW values):
   - DATABASE_URL (from Task 4.1)
   - REDIS_URL=redis://ghagga-redis:6379
   - REDIS_HOST=ghagga-redis
   - REDIS_PORT=6379
   - GITHUB_APP_ID=2991025
   - GITHUB_PRIVATE_KEY (new rotated key)
   - GITHUB_WEBHOOK_SECRET (new)
   - GITHUB_CLIENT_SECRET (new)
   - ENCRYPTION_KEY (generate: `openssl rand -hex 32`)
   - STATE_SECRET (generate: `openssl rand -base64 32`)
   - NODE_ENV=production
   - PORT=3000
3. [ ] Click "Save" after each

**Verification**:
- All vars configured
- Using NEW secrets only

---

### Task 6.4: Configure Domain
**Status**: pending
**Assignee**: User
**Estimated**: 3 min
**Dependencies**: 6.3

**Steps**:
1. [ ] Application → "General" tab
2. [ ] Domains section
3. [ ] Click "Add Domain"
4. [ ] Domain: `api.yourdomain.com`
5. [ ] Port: 3000
6. [ ] Click "Add"

**Verification**:
- Domain added

---

### Task 6.5: Configure Health Check
**Status**: pending
**Assignee**: User
**Estimated**: 2 min
**Dependencies**: 6.4

**Steps**:
1. [ ] Same "General" tab
2. [ ] Healthcheck Enabled: Toggle ON
3. [ ] Healthcheck Path: `/health`
4. [ ] Healthcheck Port: 3000

**Verification**:
- Health check configured

---

### Task 6.6: Deploy Application
**Status**: pending
**Assignee**: User
**Estimated**: 10 min
**Dependencies**: 6.5

**Steps**:
1. [ ] Tab "Deploy"
2. [ ] Click "Deploy"
3. [ ] Wait 3-5 minutes
4. [ ] Watch logs in real-time
5. [ ] Wait for "deployed successfully"

**Verification**:
- Deployment successful
- No errors in logs

---

### Task 6.7: Verify Health Endpoint
**Status**: pending
**Assignee**: User
**Estimated**: 2 min
**Dependencies**: 6.6

**Steps**:
1. [ ] Open browser: `https://api.yourdomain.com/health`
2. [ ] Should return JSON with status: "ok"

**Verification**:
- Returns 200 OK
- JSON response valid

---

## Phase 7: GitHub App Update

### Task 7.1: Update Webhook URL
**Status**: pending
**Assignee**: User
**Estimated**: 3 min
**Dependencies**: 6.7

**Steps**:
1. [ ] Go to https://github.com/settings/apps/ghagga-review
2. [ ] Scroll to "Webhook URL"
3. [ ] Change to: `https://api.yourdomain.com/webhook`
4. [ ] Verify Webhook Secret is the NEW one
5. [ ] Click "Save changes"

**Verification**:
- URL updated
- Changes saved

---

### Task 7.2: Update App URLs
**Status**: pending
**Assignee**: User
**Estimated**: 2 min
**Dependencies**: 7.1

**Steps**:
1. [ ] Same GitHub App settings page
2. [ ] Section "Identifying and authorizing users"
3. [ ] Homepage URL: `https://api.yourdomain.com`
4. [ ] Callback URL: `https://api.yourdomain.com/auth/callback`
5. [ ] Click "Save changes"

**Verification**:
- URLs updated
- Changes saved

---

## Phase 8: End-to-End Testing

### Task 8.1: Test Webhook
**Status**: pending
**Assignee**: User
**Estimated**: 5 min
**Dependencies**: 7.2

**Steps**:
1. [ ] Go to a repo with GHAGGA installed
2. [ ] Create a test PR
3. [ ] Comment: `ghagga review`

**Expected**:
- [ ] 👀 reaction appears immediately
- [ ] After 30-60s: 🚀 reaction
- [ ] After 1-2min: Review comment posted

**Verification**:
- Webhook received
- Job processed
- Review generated

---

### Task 8.2: Check Coolify Logs
**Status**: pending
**Assignee**: User
**Estimated**: 3 min
**Dependencies**: 8.1

**Steps**:
1. [ ] Coolify → ghagga-server → "Logs" tab
2. [ ] Verify webhook received
3. [ ] Verify job enqueued

**Verification**:
- Logs show webhook
- No errors

---

### Task 8.3: Check Bull Dashboard
**Status**: pending
**Assignee**: User
**Estimated**: 3 min
**Dependencies**: 8.1

**Steps**:
1. [ ] Open: `http://YOUR_HETZNER_IP:3001`
2. [ ] Verify queue "review" visible
3. [ ] Check job processed

**Verification**:
- Dashboard loads
- Jobs visible

---

## Phase 9: Cleanup

### Task 9.1: Delete Neon Account
**Status**: pending
**Assignee**: User
**Estimated**: 5 min
**Dependencies**: 8.3

**Steps**:
1. [ ] Go to https://console.neon.tech
2. [ ] Project "neondb" → Settings
3. [ ] Scroll to "Delete project"
4. [ ] Type name to confirm
5. [ ] Click "Delete"
6. [ ] (Optional) Delete account

**Verification**:
- Project deleted
- No access to old DB

---

### Task 9.2: Verify Inngest Archived
**Status**: pending
**Assignee**: User
**Estimated**: 2 min
**Dependencies**: 8.3

**Steps**:
1. [ ] Go to https://app.inngest.com
2. [ ] Verify GHAGGA app shows "Archived"

**Verification**:
- App archived
- Keys invalidated

---

### Task 9.3: Cancel Render Service
**Status**: pending
**Assignee**: User
**Estimated**: 3 min
**Dependencies**: 8.3

**Steps**:
1. [ ] Go to https://dashboard.render.com
2. [ ] Find ghagga service
3. [ ] Settings → "Delete service"
4. [ ] Confirm

**Verification**:
- Service deleted
- No billing

---

### Task 9.4: Delete Northflank Project
**Status**: pending
**Assignee**: User
**Estimated**: 3 min
**Dependencies**: 8.3

**Steps**:
1. [ ] Go to https://app.northflank.com
2. [ ] Project ghagga → Settings
3. [ ] "Delete project"
4. [ ] Confirm

**Verification**:
- Project deleted
- No billing

---

## Summary

**Total Tasks**: 42  
**Estimated Time**: ~2.5 hours  
**Phases**: 9

**Critical Path**:
1. Infrastructure (1.1-1.7) → Coolify (2.1-2.5) → DB (4.1-4.2) → Deploy (6.1-6.7) → Test (8.1-8.3)

**Dependencies**:
- User tasks: 1.x, 2.x, 3.x, 4.x, 6.x, 7.x, 8.x, 9.x (infrastructure & deploy)
- AI tasks: 5.x (code implementation)

**Success Criteria**:
- [ ] All 42 tasks completed
- [ ] GHAGGA runs on Coolify
- [ ] "ghagga review" works end-to-end
- [ ] Old accounts deleted
- [ ] Cost: $7.55/mes

---

**Ready to start?**

Begin with Phase 1: Task 1.1 (Create Hetzner Account)
