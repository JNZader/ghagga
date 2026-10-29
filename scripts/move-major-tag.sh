#!/usr/bin/env bash
# Point the floating major tag (vN) at a stable release commit.
#
# Accepts a release tag with or without a leading "v" (v3.7.0 and 3.7.0).
# The floating tag is always vN, matching JNZader/ghagga@v3. Prereleases and
# tags that are not X.Y.Z are left unchanged.
#
# Usage:
#   move-major-tag.sh [--print-major] <tag> [--push]
#   PRERELEASE=true skips the move (GitHub release prerelease flag).
set -euo pipefail

print_major() {
  local raw="$1"
  local prerelease="$2"
  local version

  if [ "$prerelease" = "true" ]; then
    echo skip
    return 0
  fi
  version="${raw#v}"
  if ! printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo skip
    return 0
  fi
  echo "v${version%%.*}"
}

# Download tag <name> if the local repo does not already have it.
fetch_tag() {
  local name="$1"
  if git rev-parse -q --verify "refs/tags/${name}^{}" >/dev/null 2>&1; then
    return 0
  fi
  git fetch --quiet origin "refs/tags/${name}:refs/tags/${name}" 2>/dev/null
}

# Print the commit a release tag points at. Tries the event tag, then the
# v-prefixed form, then the bare form, so a release created as 3.7.0 still
# resolves after it is renamed to v3.7.0 (or the other way around).
resolve_release_commit() {
  local raw="$1"
  local version="${raw#v}"
  local candidate

  for candidate in "$raw" "v${version}" "$version"; do
    if [ -z "$candidate" ] || [ "$candidate" = "v" ]; then
      continue
    fi
    if fetch_tag "$candidate"; then
      git rev-parse "refs/tags/${candidate}^{}"
      return 0
    fi
  done
  return 1
}

move_major_tag() {
  local raw="$1"
  local push_tag="$2"
  local decision target major current

  decision="$(print_major "$raw" "${PRERELEASE:-false}")"
  if [ "$decision" = "skip" ]; then
    if [ "${PRERELEASE:-false}" = "true" ]; then
      echo "Prerelease ${raw} — leaving the major tag unchanged"
    else
      echo "Tag ${raw} is not a stable X.Y.Z / vX.Y.Z release — leaving the major tag unchanged"
    fi
    return 0
  fi

  major="$decision"
  if ! target="$(resolve_release_commit "$raw")"; then
    echo "::error::Could not resolve release tag ${raw} (tried with and without a leading v)"
    return 1
  fi

  current=""
  if fetch_tag "$major"; then
    current="$(git rev-parse "refs/tags/${major}^{}")"
  fi
  if [ "$current" = "$target" ]; then
    echo "${major} already points at ${raw} (${target})"
    return 0
  fi

  local version="${raw#v}"
  git -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    tag -fa "$major" "$target" -m "Update ${major} to v${version}"
  echo "Moved ${major} to v${version} (${target})"

  if [ "$push_tag" = "1" ]; then
    git push origin "refs/tags/${major}" --force
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "${1:-}" = "--print-major" ]; then
    print_major "${2:?tag required}" "${PRERELEASE:-false}"
    exit 0
  fi
  raw="${1:?release tag required}"
  push_tag=0
  if [ "${2:-}" = "--push" ]; then
    push_tag=1
  fi
  move_major_tag "$raw" "$push_tag"
fi
