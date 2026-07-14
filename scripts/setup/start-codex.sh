#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(cd "$script_dir/../.." && pwd -P)"
codex_directory="$root/.codex"
config_path="$codex_directory/config.toml"

if [[ -L "$codex_directory" || ! -d "$codex_directory" ]]; then
  echo "Project .codex must be a real directory before Codex can start." >&2
  exit 1
fi
if [[ -L "$config_path" || ! -f "$config_path" ]]; then
  echo "Project .codex/config.toml must be a real file before Codex can start." >&2
  exit 1
fi
bash "$script_dir/validate-codex-bootstrap.sh" "$root"
if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI is not available on PATH. Install it for the current user:" >&2
  echo "  https://developers.openai.com/codex/cli/" >&2
  exit 127
fi

after_delimiter=false
for argument in "$@"; do
  if [[ "$after_delimiter" == true ]]; then
    continue
  fi
  if [[ "$argument" == "--" ]]; then
    after_delimiter=true
    continue
  fi
  case "$argument" in
    --cd | --cd=* | -C | -C?*)
      echo "Refusing Codex working-root override '$argument'; this launcher starts in $root." >&2
      exit 64
      ;;
    --add-dir | --add-dir=*)
      echo "Refusing additional writable root '$argument'; this launcher selects one project root." >&2
      exit 64
      ;;
    --config | --config=* | -c | -c?* | --profile | --profile=* | -p | -p?* | --sandbox | --sandbox=* | -s | -s?* | --ask-for-approval | --ask-for-approval=* | -a | -a?* | --dangerously-bypass-approvals-and-sandbox)
      echo "Refusing project-policy override '$argument'; edit and validate .codex/config.toml instead." >&2
      exit 64
      ;;
    --enable | --enable=* | --disable | --disable=* | --model | --model=* | -m | -m?* | --search | --remote | --remote=* | --remote-auth-token-env | --remote-auth-token-env=* | --dangerously-bypass-hook-trust | --oss | --local-provider | --local-provider=* | --image | --image=* | -i | -i?*)
      echo "Refusing untracked feature, provider, endpoint, trust, or external-input override '$argument'; use reviewed project configuration and project-local inputs." >&2
      exit 64
      ;;
  esac
done

exec env \
  -u NO_COLOR \
  codex \
  --cd "$root" \
  "$@"
