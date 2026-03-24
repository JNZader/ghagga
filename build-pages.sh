#!/usr/bin/env bash
set -euo pipefail

# Build script for Cloudflare Pages
# Replicates .github/workflows/deploy-pages.yml assembly logic
# Output: _site/ (landing + dashboard + docs)

echo "==> Detecting package manager..."
if [ -f pnpm-lock.yaml ]; then
  PM="pnpm"
  echo "    Found pnpm-lock.yaml — using pnpm"
elif [ -f package-lock.json ]; then
  PM="npm"
  echo "    Found package-lock.json — using npm"
else
  echo "ERROR: No lockfile found. Cannot determine package manager."
  exit 1
fi

echo "==> Installing dependencies..."
if [ "$PM" = "pnpm" ]; then
  pnpm install --frozen-lockfile
else
  npm ci
fi

echo "==> Building dashboard..."
if [ "$PM" = "pnpm" ]; then
  pnpm exec turbo build --filter=@ghagga/dashboard
else
  npx turbo build --filter=@ghagga/dashboard
fi

echo "==> Assembling _site/..."
rm -rf _site
mkdir -p _site _site/app _site/docs

# 1. Landing page → _site/ root
if [ -f landing/index.html ]; then
  cp landing/index.html _site/
fi
if [ -f landing/favicon.svg ]; then
  cp landing/favicon.svg _site/
fi

# 2. Dashboard build → _site/app/
if [ -d apps/dashboard/dist ]; then
  cp -r apps/dashboard/dist/* _site/app/
else
  echo "WARNING: apps/dashboard/dist not found — skipping app"
fi

# 3. Docs → _site/docs/
if [ -d docs ]; then
  cp -r docs/* _site/docs/
else
  echo "WARNING: docs/ not found — skipping docs"
fi

# 4. Prevent Jekyll processing (harmless on Cloudflare, useful if reused)
touch _site/.nojekyll

echo "==> Done! Output in _site/"
echo "    Contents:"
ls -la _site/
