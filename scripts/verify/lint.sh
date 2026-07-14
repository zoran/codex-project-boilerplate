#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(cd "$script_dir/../.." && pwd -P)"
cd "$root"

shell_files=()
javascript_files=()
json_files=()

while IFS= read -r -d '' file_path; do
  case "$file_path" in
    *.sh | scripts/git-hooks/*) shell_files+=("$file_path") ;;
  esac
  case "$file_path" in
    *.cjs | *.js | *.mjs) javascript_files+=("$file_path") ;;
  esac
  case "$file_path" in
    *.json) json_files+=("$file_path") ;;
  esac
done < <(node scripts/repository/source-inventory.mjs --null)

status=0
if (("${#shell_files[@]}" > 0)); then
  echo "Checking shell syntax..."
  for file_path in "${shell_files[@]}"; do
    bash -n "$file_path" || status=1
  done
  if command -v shellcheck >/dev/null 2>&1; then
    shellcheck "${shell_files[@]}" || status=1
  else
    echo "shellcheck is required while shell files are active." >&2
    status=1
  fi
fi

if (("${#javascript_files[@]}" > 0)); then
  echo "Checking JavaScript syntax..."
  for file_path in "${javascript_files[@]}"; do
    node --check "$file_path" || status=1
  done
fi

if (("${#json_files[@]}" > 0)); then
  echo "Checking JSON syntax..."
  for file_path in "${json_files[@]}"; do
    node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$file_path" ||
      status=1
  done
fi

if ((status != 0)); then
  echo "Lint failed." >&2
  exit "$status"
fi
echo "Lint passed."
