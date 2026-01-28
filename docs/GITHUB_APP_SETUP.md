# GitHub App Setup Guide

This guide documents the complete process for registering and configuring a GitHub App with the necessary permissions for the GHAGGA project.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Creating the GitHub App](#creating-the-github-app)
3. [Required Permissions](#required-permissions)
4. [Webhook Configuration](#webhook-configuration)
5. [Generating Credentials](#generating-credentials)
6. [Installation](#installation)
7. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before starting, ensure you have:

- A GitHub account with permission to create GitHub Apps
- Access to the target organization (if creating an org-level app)
- Your Supabase project URL (for webhook endpoint)

---

## Creating the GitHub App

### Step 1: Navigate to GitHub App Settings

1. Go to **GitHub.com** > **Settings** > **Developer settings** > **GitHub Apps**
2. Or navigate directly to: `https://github.com/settings/apps`

### Step 2: Create New GitHub App

1. Click **"New GitHub App"**
2. Fill in the basic information:

| Field | Value |
|-------|-------|
| **GitHub App name** | `ghagga-reviewer` (or your preferred name) |
| **Description** | Multi-agent PR review system |
| **Homepage URL** | Your project URL or repository URL |

### Step 3: Configure Identifying and Authorization

- **Callback URL**: Leave empty (not needed for this app)
- **Setup URL**: Leave empty
- **Webhook URL**: `https://your-project.supabase.co/functions/v1/webhook`
- **Webhook secret**: Generate using `openssl rand -hex 32`

---

## Required Permissions

Configure the following permissions for your GitHub App:

### Repository Permissions

| Permission | Access Level | Purpose |
|------------|--------------|---------|
| **Contents** | Read | Read repository files for code analysis |
| **Metadata** | Read | Required by GitHub (mandatory) |
| **Pull requests** | Read & Write | Read PR details and post review comments |

### Organization Permissions

| Permission | Access Level | Purpose |
|------------|--------------|---------|
| **Members** | Read | (Optional) Identify organization members |

### Account Permissions

No account permissions are required.

### Subscribe to Events

Enable the following webhook events:

- [x] **Pull request** - Triggered when PRs are opened, closed, or synchronized
- [x] **Pull request review** - Triggered when reviews are submitted
- [x] **Pull request review comment** - Triggered when review comments are created

---

## Webhook Configuration

### Webhook URL

Set the webhook URL to your Supabase Edge Function endpoint:

```
https://<your-project-ref>.supabase.co/functions/v1/webhook
```

### Webhook Secret

Generate a secure webhook secret:

```bash
# Using OpenSSL
openssl rand -hex 32

# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Using Python
python -c "import secrets; print(secrets.token_hex(32))"
```

**Important**: Save this secret securely. You'll need it for:
1. The GitHub App configuration
2. Your environment variables (`GITHUB_WEBHOOK_SECRET`)

### Content Type

Set the webhook content type to: `application/json`

### SSL Verification

Keep SSL verification **enabled** (recommended for production).

---

## Generating Credentials

### Step 1: Generate Private Key

1. After creating the app, scroll to **"Private keys"** section
2. Click **"Generate a private key"**
3. A `.pem` file will be downloaded automatically
4. Store this file securely - it cannot be downloaded again

### Step 2: Convert Private Key to Base64 (for environment variables)

```bash
# Linux/macOS
cat your-app-name.private-key.pem | base64 -w 0

# Windows (PowerShell)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("your-app-name.private-key.pem"))

# Windows (Git Bash)
cat your-app-name.private-key.pem | base64 -w 0
```

### Step 3: Note Your App Credentials

After creating the app, note down:

| Credential | Location | Environment Variable |
|------------|----------|---------------------|
| **App ID** | App settings page (top) | `GITHUB_APP_ID` |
| **Client ID** | App settings page | `GITHUB_CLIENT_ID` |
| **Client Secret** | Generate in app settings | `GITHUB_CLIENT_SECRET` |
| **Private Key** | Downloaded .pem file (base64) | `GITHUB_PRIVATE_KEY` |
| **Webhook Secret** | What you set during creation | `GITHUB_WEBHOOK_SECRET` |

---

## Installation

### Install on Your Account

1. Go to your GitHub App's public page: `https://github.com/apps/<your-app-name>`
2. Click **"Install"**
3. Choose the account or organization
4. Select repositories:
   - **All repositories** (full access)
   - **Only select repositories** (recommended for testing)
5. Click **"Install"**

### Install on an Organization

1. Navigate to **Organization Settings** > **Installed GitHub Apps**
2. Click **"Install"** next to your app
3. Configure repository access
4. Confirm installation

### Getting the Installation ID

After installation, you'll be redirected to a URL like:
```
https://github.com/settings/installations/12345678
```

The number at the end (`12345678`) is your **Installation ID**. Save it as `GITHUB_INSTALLATION_ID`.

Alternatively, use the GitHub API:
```bash
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  https://api.github.com/app/installations
```

---

## Troubleshooting

### Common Issues

#### Webhook Not Receiving Events

1. Verify the webhook URL is correct
2. Check Supabase Edge Function logs
3. Verify webhook secret matches environment variable
4. Test with GitHub's webhook delivery log (in App settings > Advanced)

#### Permission Denied Errors

1. Verify the app is installed on the target repository
2. Check that required permissions are configured
3. Ensure the installation hasn't been suspended

#### Invalid Signature Errors

1. Verify `GITHUB_WEBHOOK_SECRET` matches exactly
2. Check for trailing whitespace or newlines
3. Ensure you're using the raw request body for signature verification

### Useful Links

- [GitHub Apps Documentation](https://docs.github.com/en/apps)
- [Webhook Events and Payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [Authenticating as a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app)

---

## Security Best Practices

1. **Never commit credentials** - Use environment variables
2. **Rotate keys periodically** - Generate new private keys every 6-12 months
3. **Use minimum permissions** - Only request what you need
4. **Monitor webhook deliveries** - Check for failed deliveries regularly
5. **Keep webhook secret secure** - Treat it like a password
