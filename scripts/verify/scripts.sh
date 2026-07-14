#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(cd "$script_dir/../.." && pwd -P)"
cd "$root"

status=0
while IFS= read -r -d '' file_path; do
  if [[ "$file_path" == scripts/*.sh || "$file_path" == scripts/git-hooks/* ]]; then
    if [[ ! -x "$file_path" ]]; then
      echo "Script must be executable: $file_path" >&2
      status=1
    fi
    if [[ "$(head -c 2 -- "$file_path")" != "#!" ]]; then
      echo "Executable script needs a shebang: $file_path" >&2
      status=1
    fi
  fi
done < <(node scripts/repository/source-inventory.mjs --null)

if ((status != 0)); then
  exit "$status"
fi
echo "Script verification passed."
