#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(cd "$script_dir/../.." && pwd -P)"
cd "$root"

while [[ "${1:-}" == "--" ]]; do
  shift
done

remote_name="${1:-}"
remote_url="${2:-}"

refs_file="$(mktemp)"
trap 'rm -f "$refs_file"' EXIT
if [[ ! -t 0 ]]; then
  cat >"$refs_file"
fi

if [[ -n "$remote_url" ]]; then
  echo "Validating the target push remote."
  node scripts/verify/git-remote-identity.mjs \
    --remote-name "$remote_name" \
    --remote-url "$remote_url"
else
  echo "Validating configured push remotes for direct invocation."
  node scripts/verify/git-remote-identity.mjs
fi

echo "Validating that pre-push checks read the exact pushed commit from a clean checkout."
node scripts/verify/adaptive.mjs --validate-pre-push-refs <"$refs_file"

echo "Scanning every newly introduced commit and changed blob in the pushed ref ranges."
node scripts/verify/pushed-object-scan.mjs <"$refs_file"

echo "Running the complete deterministic verification plan for the pushed commit."
node scripts/verify/adaptive.mjs --mode pre-push

echo "Revalidating the pushed commit after the full-tree checks."
node scripts/verify/adaptive.mjs --validate-pre-push-refs <"$refs_file"

if [[ -n "$(git status --porcelain=v1 --untracked-files=normal --ignore-submodules=none)" ]]; then
  cat >&2 <<'EOF'
Pre-push verification changed the working tree. The push was blocked because verification must be
read-only with respect to committable repository state.
EOF
  exit 1
fi

echo "Pre-push verification passed."
