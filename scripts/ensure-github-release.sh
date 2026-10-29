#!/usr/bin/env bash
# After a successful Release workflow run, make sure the fixed-group version
# has a GitHub Release vX.Y.Z (changelog notes) and that the floating major
# tag vN points at that commit.
#
# Releases created with GITHUB_TOKEN do not trigger other workflows, so
# major-tag.yml does not see them. This script does that move in-process.
# It also repairs a missing vN for the version already in package.json
# (v3 was never created for v3.7.0) without retagging the merge commit:
# the major tag follows the existing vX.Y.Z tag when that tag is already there.
set -euo pipefail

published_file="${GHAGGA_PUBLISHED_FILE:-${RUNNER_TEMP:-/tmp}/ghagga-published.tsv}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

version="$(node -p "require('./apps/cli/package.json').version")"
if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ghagga@${version} is not a stable X.Y.Z release — not creating a GitHub Release or moving vN"
  exit 0
fi

tag="v${version}"
code="$(curl -sS -o /dev/null -w '%{http_code}' --retry 3 --retry-delay 2 --retry-all-errors "https://registry.npmjs.org/ghagga/${version}")"
if [ "$code" != "200" ]; then
  echo "ghagga@${version} is not on npm (HTTP ${code}) — not creating a GitHub Release"
  exit 0
fi

extract_changelog() {
  local file="$1"
  local ver="$2"
  awk -v ver="$ver" '
    $0 ~ "^## " ver "$" { found = 1; next }
    found && /^## / { exit }
    found { print }
  ' "$file"
}

notes="$(mktemp)"
{
  echo "Lockstep release of ghagga, ghagga-core, ghagga-db, and ghagga-forge at ${tag}."
  echo "ghagga-triage-engine versions independently and is included below only when it published in this run."
  echo
} >"$notes"

append_notes() {
  local name="$1"
  local ver="$2"
  local changelog="$3"
  local entry
  echo "## ${name}@${ver}" >>"$notes"
  echo >>"$notes"
  if [ -f "$changelog" ]; then
    entry="$(extract_changelog "$changelog" "$ver")"
  else
    entry=""
  fi
  if [ -n "$entry" ]; then
    printf '%s\n' "$entry" >>"$notes"
  else
    echo "_No changelog entry for ${name}@${ver}._" >>"$notes"
  fi
  echo >>"$notes"
}

if [ -s "$published_file" ]; then
  while IFS=$'\t' read -r name ver dir; do
    [ -n "${name:-}" ] || continue
    append_notes "$name" "$ver" "${dir}/CHANGELOG.md"
  done <"$published_file"
else
  append_notes "ghagga" "$version" "apps/cli/CHANGELOG.md"
fi

if gh release view "$tag" >/dev/null 2>&1; then
  echo "GitHub Release ${tag} already exists"
else
  if [ -z "${GITHUB_SHA:-}" ]; then
    echo "::error::GITHUB_SHA is required to create ${tag}" >&2
    exit 1
  fi
  gh release create "$tag" \
    --target "$GITHUB_SHA" \
    --title "$tag" \
    --notes-file "$notes"
  echo "Created GitHub Release ${tag}"
fi

bash "${root}/scripts/move-major-tag.sh" "$tag" --push
