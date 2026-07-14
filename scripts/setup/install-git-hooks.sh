#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(cd "$script_dir/../.." && pwd -P)"
cd "$root"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "No Git worktree found; skipping hook installation."
  exit 0
fi

source_hook="scripts/git-hooks/pre-push"
if [[ -L "$source_hook" || ! -f "$source_hook" ]]; then
  echo "Repository-managed pre-push source must be a real file." >&2
  exit 1
fi
git_common_dir="$(git rev-parse --git-common-dir)"
git_hooks_path="$(git rev-parse --git-path hooks)"
hooks_dir="$(
  node scripts/setup/resolve-git-hooks-path.mjs "$root" "$git_common_dir" "$git_hooks_path"
)"
target_hook="$hooks_dir/pre-push"
mkdir -p -- "$hooks_dir"

if [[ -L "$hooks_dir" || ! -d "$hooks_dir" ]]; then
  echo "Refusing unsafe Git hooks directory: $hooks_dir" >&2
  exit 1
fi

if [[ -L "$target_hook" ]]; then
  echo "Refusing to replace symlinked hook: $target_hook" >&2
  exit 1
fi
if [[ -e "$target_hook" ]] && ! cmp -s -- "$source_hook" "$target_hook"; then
  if ! rg -q --fixed-strings "# Managed by this repository; installed by hooks:install." "$target_hook"; then
    echo "Existing pre-push hook is not repository-managed; leaving it unchanged: $target_hook" >&2
    echo "Integrate scripts/git-hooks/pre-push manually or remove the existing hook explicitly." >&2
    exit 1
  fi
fi

temporary_hook="$(mktemp "$hooks_dir/.pre-push.XXXXXX")"
trap 'rm -f -- "$temporary_hook"' EXIT
cp -- "$source_hook" "$temporary_hook"
chmod 755 -- "$temporary_hook"
mv -f -- "$temporary_hook" "$target_hook"
trap - EXIT
echo "Installed repository-managed pre-push hook."
