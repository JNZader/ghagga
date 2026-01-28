# Deployment Guide

This document covers deployment options for the GHAGGA project.

## Table of Contents

1. [Dashboard Deployment (GitHub Pages)](#dashboard-deployment-github-pages)
2. [Supabase Edge Functions](#supabase-edge-functions)
3. [Environment Variables](#environment-variables)

---

## Dashboard Deployment (GitHub Pages)

The dashboard is automatically deployed to GitHub Pages when changes are pushed to the `main` branch.

### Automatic Deployment

The workflow triggers on:
- Push to `main` branch (when files in `dashboard/` change)
- Manual dispatch via GitHub Actions UI

### Required Secrets

Configure these secrets in your repository settings (**Settings** > **Secrets and variables** > **Actions**):

| Secret | Description |
|--------|-------------|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous key for client access |

### Enabling GitHub Pages

1. Go to repository **Settings** > **Pages**
2. Under "Build and deployment", select **GitHub Actions** as the source
3. The workflow will handle the rest

### Manual Deployment

To trigger a manual deployment:

1. Go to **Actions** > **Deploy Dashboard to GitHub Pages**
2. Click **Run workflow**
3. Select the branch and click **Run workflow**

### Accessing the Dashboard

After deployment, the dashboard is available at:

```
https://<username>.github.io/ghagga/
```

### Custom Domain (Optional)

To use a custom domain:

1. Go to repository **Settings** > **Pages**
2. Under "Custom domain", enter your domain
3. Configure DNS records as instructed
4. Update `dashboard/vite.config.ts` base path if needed

---

## Supabase Edge Functions

Edge functions are deployed using the Supabase CLI.

### Deploy Functions

```bash
# Deploy all functions
supabase functions deploy

# Deploy a specific function
supabase functions deploy webhook
```

### Set Secrets

```bash
supabase secrets set GITHUB_APP_ID=123456
supabase secrets set GITHUB_PRIVATE_KEY="$(cat private-key.pem | base64 -w 0)"
```

See [ENV_VARIABLES.md](./ENV_VARIABLES.md) for the complete list of required secrets.

---

## Environment Variables

For a complete list of environment variables and how to configure them, see [ENV_VARIABLES.md](./ENV_VARIABLES.md).
