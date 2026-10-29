#!/usr/bin/env bash
# Publish public packages that are not already on npm.
#
# Order is the dependency order used by the historical Publish to npm workflow:
# ghagga-db → ghagga-core → ghagga-forge → ghagga → ghagga-triage-engine.
# Auth is the existing npm token (NODE_AUTH_TOKEN / secrets.NPM_TOKEN) plus
# provenance (NPM_CONFIG_PROVENANCE and --provenance, which needs id-token: write).
#
# A version already on the registry is skipped. pnpm's "Published" line is
# not treated as proof: the public registry lagged the 3.7.0 run by a few
# minutes (about five for ghagga-db), so the job was green while npm view
# still showed the previous version. This script waits until the version is
# readable and fails the job if it never appears.
#
# Newly published packages are appended to $GHAGGA_PUBLISHED_FILE
# (name<TAB>version<TAB>directory) for the release step.
set -euo pipefail

published_file="${GHAGGA_PUBLISHED_FILE:-${RUNNER_TEMP:-/tmp}/ghagga-published.tsv}"
mkdir -p "$(dirname "$published_file")"
: >"$published_file"

# changesets/action reads this ndjson file after a custom publish script.
# An empty file means "no package tags"; we create vX.Y.Z ourselves.
if [ -n "${CHANGESETS_OUTPUT:-}" ]; then
  mkdir -p "$(dirname "$CHANGESETS_OUTPUT")"
  : >"$CHANGESETS_OUTPUT"
fi

# Dependency order. triage-engine is intentionally last and is not in the
# fixed group: it versions on its own.
dirs=(
  packages/db
  packages/core
  packages/forge
  apps/cli
  packages/triage-engine
)

registry_code() {
  local name="$1"
  local version="$2"
  curl -sS -o /dev/null -w '%{http_code}' \
    --retry 3 --retry-delay 2 --retry-all-errors \
    "https://registry.npmjs.org/${name}/${version}"
}

# 200: present. 404: absent. Anything else aborts so an outage is not treated
# as "already published" or as "needs publish".
require_registry_state() {
  local name="$1"
  local version="$2"
  local code
  code="$(registry_code "$name" "$version")"
  case "$code" in
    200 | 404) printf '%s\n' "$code" ;;
    *)
      echo "::error::npm registry probe for ${name}@${version} returned HTTP ${code}" >&2
      return 1
      ;;
  esac
}

wait_until_published() {
  local name="$1"
  local version="$2"
  local attempt code
  # 3.7.0 took about five minutes to become readable. Wait up to eight.
  for attempt in $(seq 1 24); do
    # A blip during replication should not fail the job; only the final miss does.
    code="$(registry_code "$name" "$version" || true)"
    if [ "$code" = "200" ]; then
      echo "${name}@${version} is on npm"
      return 0
    fi
    echo "Waiting for ${name}@${version} to appear on npm (${attempt}/24, last HTTP ${code:-curl-failed})"
    if [ "$attempt" -lt 24 ]; then
      sleep 20
    fi
  done
  echo "::error::${name}@${version} is not on npm after publish. The job fails instead of going green while the registry still serves the previous version." >&2
  return 1
}

needs=()
for dir in "${dirs[@]}"; do
  name="$(node -p "require('./${dir}/package.json').name")"
  version="$(node -p "require('./${dir}/package.json').version")"
  code="$(require_registry_state "$name" "$version")"
  if [ "$code" = "200" ]; then
    echo "::notice::${name}@${version} is already on npm — skipping publish"
  else
    needs+=("$dir")
  fi
done

if [ "${#needs[@]}" -eq 0 ]; then
  echo "Every publishable package version is already on npm. Nothing to publish."
  exit 0
fi

echo "Publishing ${#needs[@]} package(s): ${needs[*]}"
pnpm turbo build
pnpm turbo test

for dir in "${needs[@]}"; do
  name="$(node -p "require('./${dir}/package.json').name")"
  version="$(node -p "require('./${dir}/package.json').version")"
  (
    cd "$dir"
    pnpm publish --access public --no-git-checks --provenance
  )
  wait_until_published "$name" "$version"
  printf '%s\t%s\t%s\n' "$name" "$version" "$dir" >>"$published_file"
done
